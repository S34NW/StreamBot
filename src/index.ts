import { Client, TextChannel, CustomStatus, Message, ActivityOptions } from "discord.js-selfbot-v13";
import { NewApi, StreamOptions, Streamer, Utils } from "@dank074/discord-video-stream";
import config from "./config.js";
import fs from 'fs';
import path from 'path';
import ytdl from '@distube/ytdl-core';
import yts, { video_info } from 'play-dl';
import { getVideoParams } from "./utils/ffmpeg.js";
import logger from './utils/logger.js';
import { Youtube } from './utils/youtube.js';
import { time } from "console";

// Create a new instance of Streamer
const streamer = new Streamer(new Client());

// Create a cancelable command
let current: ReturnType<typeof NewApi.prepareStream>["command"];

// Create a new instance of Youtube
const youtube = new Youtube();

const streamOpts: StreamOptions = {
    width: config.width,
    height: config.height,
    fps: config.fps,
    bitrateKbps: config.bitrateKbps,
    maxBitrateKbps: config.maxBitrateKbps,
    hardwareAcceleratedDecoding: config.hardwareAcceleratedDecoding,
    videoCodec: Utils.normalizeVideoCodec(config.videoCodec),
    rtcpSenderReportEnabled: true,
    h26xPreset: config.h26xPreset,
    minimizeLatency: true,
    forceChacha20Encryption: true
};

// Create preview cache directory structure
fs.mkdirSync(config.previewCacheDir, { recursive: true });

// Get all video files
const videoExtensions = ['.mp4', '.mkv', '.avi', '.mov', '.wmv'];

const readDirRecursive = (dir: string): string[] => {
    let results: string[] = [];
    const list = fs.readdirSync(dir, { withFileTypes: true });
    list.forEach((file) => {
        const filePath = path.resolve(dir, file.name);
        if (file.isDirectory()) {
            results = results.concat(readDirRecursive(filePath));
        } else if (videoExtensions.includes(path.extname(file.name).toLowerCase())) {
            results.push(filePath);
        }
    });
    return results;
};

const videoFiles = readDirRecursive(config.videosDir);

// Create an array of video objects
let videos = videoFiles.map(file => {
    const fileName = path.parse(file).name;
    // replace space with _
    return { name: fileName.replace(/ /g, '_'), path: file};
});

// print out all videos
logger.info(`Available videos:\n${videos.map(m => m.name).join('\n')}`);

// Ready event
streamer.client.on("ready", async () => {
    if (streamer.client.user) {
        logger.info(`${streamer.client.user.tag} is ready`);
        streamer.client.user?.setActivity(status_idle() as ActivityOptions);
    }
});

// Stream status object
const streamStatus = {
    joined: false,
    joinsucc: false,
    playing: false,
    channelInfo: {
        guildId: config.guildId,
        channelId: config.videoChannelId,
        cmdChannelId: config.cmdChannelId
    }
}

// Voice state update event
streamer.client.on('voiceStateUpdate', async (oldState, newState) => {
    // When exit channel
    if (oldState.member?.user.id == streamer.client.user?.id) {
        if (oldState.channelId && !newState.channelId) {
            streamStatus.joined = false;
            streamStatus.joinsucc = false;
            streamStatus.playing = false;
            streamStatus.channelInfo = {
                guildId: config.guildId,
                channelId: config.videoChannelId,
                cmdChannelId: config.cmdChannelId
            }
            streamer.client.user?.setActivity(status_idle() as ActivityOptions);
        }
    }

    // When join channel success
    if (newState.member?.user.id == streamer.client.user?.id) {
        if (newState.channelId && !oldState.channelId) {
            streamStatus.joined = true;
            if (newState.guild.id == streamStatus.channelInfo.guildId && newState.channelId == streamStatus.channelInfo.channelId) {
                streamStatus.joinsucc = true;
            }
        }
    }
})

// Message create event
streamer.client.on('messageCreate', async (message) => {
    if (
        message.author.bot ||
        message.author.id === streamer.client.user?.id ||
        !config.cmdChannelId.includes(message.channel.id.toString()) ||
        !message.content.startsWith(config.prefix!)
    ) return; // Ignore bots, self, non-command channels, and non-commands

    const args = message.content.slice(config.prefix!.length).trim().split(/ +/); // Split command and arguments

    if (args.length === 0) return; // No arguments provided

    const user_cmd = args.shift()!.toLowerCase();
    const [guildId, channelId] = [config.guildId, config.videoChannelId!];

    if (config.cmdChannelId.includes(message.channel.id)) {
        switch (user_cmd) {
            case 'play':
                {
                    if (streamStatus.joined) {
                        sendError(message, 'Already playing a video, end it first.');
                        return;
                    }
                    // Get video name or index and find video file
                    const videoArg = args.join('_')
                    let video;

                    if (!isNaN(Number(videoArg))) {
                        const videoIndex = Number(videoArg) - 1;
                        if (videoIndex >= 0 && videoIndex < videos.length) {
                            video = videos[videoIndex];
                        }
                    } else {
                        video = videos.find(m => m.name === videoArg);
                    }

                    if (!video) {
                        await sendError(message, `Video ${videoArg} not found`);
                        return;
                    }

                    const resolution = await getVideoParams(video.path);
                    // Check if the respect video parameters environment variable is enabled
                    if (config.respect_video_params) {
                        logger.info(`Checking video params ${video.path}`);
                        // Checking video params
                        try {

                            streamOpts.height = resolution.height;
                            streamOpts.width = resolution.width;
                            if (resolution.bitrate != "N/A") {
                                streamOpts.bitrateKbps = Math.floor(Number(resolution.bitrate) / 1000);
                            }

                            if (resolution.maxbitrate != "N/A") {
                                streamOpts.maxBitrateKbps = Math.floor(Number(resolution.bitrate) / 1000);
                            }

                            if (resolution.fps) {
                                streamOpts.fps = resolution.fps;
                            }

                        } catch (error) {
                            logger.error('Unable to determine resolution, using static resolution....', error);
                        }
                    }

                    // Log playing video
                    logger.info(`Playing local video: ${video.path}`);

                    // Send playing message
                    sendPlaying(message, video.name || "Local Video", Number(resolution.length), video.path);

                    // Play video
                    playVideo(video.path, videoArg);
                }
                break;
            case 'playlink':
                {
                    if (streamStatus.joined) {
                        sendError(message, 'Already joined');
                        return;
                    }

                    const link = args.shift() || '';

                    if (!link) {
                        await sendError(message, 'Please provide a link.');
                        return;
                    }


                    switch (true) {
                        case ytdl.validateURL(link):
                            {
                                const [videoInfo, yturl] = await Promise.all([
                                    ytdl.getInfo(link),
                                    getVideoUrl(link).catch(error => {
                                        logger.error("Error:", error);
                                        return null;
                                    })
                                ]);

                                if (yturl) {
                                    sendPlaying(message, videoInfo.videoDetails.title, Number(videoInfo.videoDetails.lengthSeconds), null);
                                    playVideo(yturl, videoInfo.videoDetails.title);
                                }
                            }
                            break;
                        default:
                            {
                                sendPlaying(message, "URL", null, null);
                                playVideo(link, "URL");
                            }
                    }
                }
                break;
            case 'stop':
                {
                    if (!streamStatus.joined) {
                        sendError(message, '**Already Stopped!**');
                        return;
                    }

                    current?.kill("SIGTERM");
                    streamer.leaveVoice();
                    logger.info("Stopped command recieved");
                }
                break;
            case 'list':
                {
                    // Refresh video list
                    const videoFiles = readDirRecursive(config.videosDir);
                    videos = videoFiles.map(file => {
                        const fileName = path.parse(file).name;
                        return { name: fileName, path: file };
                    });
                    const videoList = videos.map((video, index) => {
                        const imdbMatch = video.path.match(/\[imdbid-(tt\d+)\]/);
                        const imdbId = imdbMatch ? imdbMatch[1] : null;
                        const imdbLink = imdbId ? `https://www.imdb.com/title/${imdbId}/` : '';
                        return `${index + 1}. [${video.name}](<${imdbLink}>)`;
                    });
                    if (videoList.length > 0) {
                        await sendPaginatedList(message, videoList);
                    } else {
                        await sendError(message, 'No videos found');
                    }
                }
                break;
            case 'status':
                {
                    await sendInfo(message, 'Status',
                        `Joined: ${streamStatus.joined}\nPlaying: ${streamStatus.playing}`);
                }
                break;
            case 'help':
                {
                    // Help text
                    const helpText = [
                        '📽 **Available Commands**',
                        '',
                        '🎬 **Media**',
                        `\`${config.prefix}play\` - Play local video, either by name or number obtained from !list`,
                        `\`${config.prefix}playlink\` - Play video from URL/YouTube`,
                        `\`${config.prefix}stop\` - Stop playback`,
                        '',
                        '🛠️ **Utils**',
                        `\`${config.prefix}list\` - Show local videos, page scrolling stops after 2 minutes`,
                        `\`${config.prefix}status\` - Show status`,
                        `\`${config.prefix}help\` - Show this help`
                    ].join('\n');

                    // React with clipboard emoji
                    await message.react('📋');

                    // Reply with all commands
                    await message.reply(helpText);
                }
                break;
            default:
                {
                    await sendError(message, 'Invalid command');
                }
        }
    }
});

// Function to play video
async function playVideo(video: string, title?: string) {
    logger.info("Started playing " + video);
    const [guildId, channelId, cmdChannelId] = [config.guildId, config.videoChannelId, config.cmdChannelId!];

    // Join voice channel
    await streamer.joinVoice(guildId, channelId, streamOpts)
    streamStatus.joined = true;
    streamStatus.playing = true;
    streamStatus.channelInfo = {
        guildId: guildId,
        channelId: channelId,
        cmdChannelId: cmdChannelId
    }

    try {
        if (title) {
            streamer.client.user?.setActivity(status_watch(title) as ActivityOptions);
        }

        const { command, output } = NewApi.prepareStream(video, {
            width: streamOpts.width,
            height: streamOpts.height,
            frameRate: streamOpts.fps,
            bitrateVideo: streamOpts.bitrateKbps,
            bitrateVideoMax: streamOpts.maxBitrateKbps,
            hardwareAcceleratedDecoding: streamOpts.hardwareAcceleratedDecoding,
            videoCodec: Utils.normalizeVideoCodec(streamOpts.videoCodec)
        })

        current = command;
        await NewApi.playStream(output, streamer)
            .catch(() => current?.kill("SIGTERM"));
        logger.info(`Finished playing video: ${video}`);
        return;

    } catch (error) {
        logger.error("Error occurred while playing video:", error);
        current?.kill("SIGTERM");
        streamer.leaveVoice();
    } finally {
        streamer.stopStream()
        streamer.leaveVoice();
        await sendFinishMessage();
        await cleanupStreamStatus();
    }
}

// Function to cleanup stream status
async function cleanupStreamStatus() {
    streamer.leaveVoice();
    streamer.client.user?.setActivity(status_idle() as ActivityOptions);

    streamStatus.joined = false;
    streamStatus.joinsucc = false;
    streamStatus.playing = false;
    streamStatus.channelInfo = {
        guildId: "",
        channelId: "",
        cmdChannelId: "",
    };
}

// Function to get video URL from YouTube
async function getVideoUrl(videoUrl: string): Promise<string | null> {
    return await youtube.getVideoUrl(videoUrl);
}

// Function to play video from YouTube
async function ytPlayTitle(title: string): Promise<string | null> {
    return await youtube.searchAndPlay(title);
}

// Function to search for videos on YouTube
async function ytSearch(title: string): Promise<string[]> {
    return await youtube.search(title);
}

const status_idle = () => {
    return new CustomStatus(new Client())
        .setEmoji('⏹️')
        .setState('Lurking Around!')
}

const status_watch = (name: string) => {
    return new CustomStatus(new Client())
        .setEmoji('📽')
        .setState(`Playing ${name}...`)
}

// Funtction to send playing message
async function sendPlaying(message: Message, title: string, length: number | null, path: string | null) {
    const imdbMatch = path?.match(/\[imdbid-(tt\d+)\]/);
    const imdbId = imdbMatch ? imdbMatch[1] : null;
    const imdbLink = imdbId ? `https://www.imdb.com/title/${imdbId}/` : '';
    const endTime = length ? `<t:${Math.trunc(Math.floor(Date.now() / 1000) + length)}` : 'Unknown';
    const content = `📽 **Now Playing**: ` + (imdbLink ? `[${title.replace(/_/g, ' ')}](${imdbLink})` : `${title.replace(/_/g, ' ')}`) + `\n**Expected end time**: ${endTime}:t>, ${endTime}:R>`;
    await Promise.all([
        message.react('▶️'),
        message.reply(content)
    ]);
}

// Function to send finish message
async function sendFinishMessage() {
    const channel = streamer.client.channels.cache.get(config.cmdChannelId.toString()) as TextChannel;
    if (channel) {
        channel.send('⏹️ **Finished**: Finished playing video.');
    }
}

// Function to send video list message
async function sendList(message: Message, items: string[], type?: string) {
    await message.react('📋');
    if (type == "ytsearch") {
        const string = `📋 **Search Results**:\n${items.join('\n')}`
        await message.reply(string.slice(0, 1999));
    }
}

// Function to send paginated list
async function sendPaginatedList(message: Message, list: string[]) {
    const chunkSize = 1900;
    const chunks: string[] = [];
    let currentChunk = '';

    list.forEach(item => {
        if ((currentChunk + item).length > chunkSize) {
            chunks.push(currentChunk);
            currentChunk = '';
        }
        currentChunk += item + '\n';
    });

    if (currentChunk) {
        chunks.push(currentChunk);
    }

    if (chunks.length === 0) {
        await message.channel.send('No items to display.');
        return;
    }

    let currentPage = 0;

    const createMessageContent = () => `${chunks[currentPage] || 'No items to display.'}\n\n**Page ${currentPage + 1} of ${chunks.length}**`;

    const sentMessage = await message.channel.send(createMessageContent());

    if (chunks.length > 1) {
        await sentMessage.react('⏮️'); // First page
        await sentMessage.react('⬅️'); // Previous page
        await sentMessage.react('➡️'); // Next page
        await sentMessage.react('⏭️'); // Last page

        const filter = (reaction, user) => ['⏮️', '⬅️', '➡️', '⏭️'].includes(reaction.emoji.name) && !user.bot;
        const collector = sentMessage.createReactionCollector({ filter, time: 120000 });

        collector.on('collect', (reaction, user) => {
            reaction.users.remove(user.id);

            if (reaction.emoji.name === '➡️') {
                if (currentPage < chunks.length - 1) {
                    currentPage++;
                }
            } else if (reaction.emoji.name === '⬅️') {
                if (currentPage > 0) {
                    currentPage--;
                }
            } else if (reaction.emoji.name === '⏮️') {
                currentPage = 0;
            } else if (reaction.emoji.name === '⏭️') {
                currentPage = chunks.length - 1;
            }

            sentMessage.edit(createMessageContent());
        });

        collector.on('end', () => {
            sentMessage.reactions.removeAll();
        });
    }
}

// Function to send info message
async function sendInfo(message, title, description) {
    await message.react('ℹ️');
    await message.channel.send(`ℹ️ **${title}**: ${description}`);
}

// Function to send success message
async function sendSuccess(message: Message, description: string) {
    await message.react('✅');
    await message.channel.send(`✅ **Success**: ${description}`);
}

// Function to send error message
async function sendError(message: Message, error: string) {
    await message.react('❌');
    await message.reply(`❌ **Error**: ${error}`);
}

// Function to send crash message
function sendCrash() {
    const channel = streamer.client.channels.cache.get(config.cmdChannelId.toString()) as TextChannel;
    if (channel) {
        channel.send(`❌ **I just crashed, shout at Sean** ❌`);
    }
}

// Login to Discord
streamer.client.login(config.token);

// Prevent the script from exiting when the ffmpeg process terminates
process.on('uncaughtException', (error) => {
    if ((error as NodeJS.ErrnoException).code !== 'SIGTERM') {
        logger.error('Uncaught Exception:', error);
        return
    }
    sendCrash();
});
