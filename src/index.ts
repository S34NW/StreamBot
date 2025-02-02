import { Client, TextChannel, CustomStatus, Message, ActivityOptions } from "discord.js-selfbot-v13";
import { streamLivestreamVideo, MediaUdp, StreamOptions, Streamer, Utils } from "@dank074/discord-video-stream";
import config from "./config.js";
import fs from 'fs';
import path from 'path';
import ytdl from '@distube/ytdl-core';
import { getStream, getVod } from 'twitch-m3u8';
import yts from 'play-dl';
import { getVideoParams, ffmpegScreenshot } from "./utils/ffmpeg.js";
import PCancelable, { CancelError } from "p-cancelable";
import logger from './utils/logger.js';
import { Youtube } from './utils/youtube.js';

// Create a new instance of Streamer
const streamer = new Streamer(new Client());

// Create a cancelable command
let command: PCancelable<string> | undefined;

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

    /**
     * Advanced options
     *
     * Enables sending RTCP sender reports. Helps the receiver synchronize the audio/video frames, except in some weird
     * cases which is why you can disable it
     */
    rtcpSenderReportEnabled: true,

    /**
     * Ffmpeg will read frames at native framerate.
     * Disabling this make ffmpeg read frames as fast as possible and setTimeout will be used to control output fps instead.
     * Enabling this can result in certain streams having video/audio out of sync
     */
    readAtNativeFps: false,

    /**
     * Encoding preset for H264 or H265. The faster it is, the lower the quality
     * Available presets: ultrafast, superfast, veryfast, faster, fast, medium, slow, slower, veryslow
     */
    h26xPreset: config.h26xPreset
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
                        sendError(message, 'Already joined');
                        return;
                    }
                    // Get video name or index and find video file
                    const videoArg = args.shift();
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

                    // Check if the respect video parameters environment variable is enabled
                    if (config.respect_video_params) {
                        logger.info(`Checking video params ${video.path}`);
                        // Checking video params
                        try {
                            const resolution = await getVideoParams(video.path);
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
                    // Join voice channel
                    await streamer.joinVoice(guildId, channelId, streamOpts)
                    // Create stream
                    const streamUdpConn = await streamer.createStream(streamOpts);
                    streamStatus.joined = true;
                    streamStatus.playing = true;
                    streamStatus.channelInfo = {
                        guildId: guildId,
                        channelId: channelId,
                        cmdChannelId: message.channel.id
                    }

                    // Log playing video
                    logger.info(`Playing local video: ${video.path}`);

                    // Send playing message
                    sendPlaying(message, video.name || "Local Video");

                    // Play video
                    playVideo(video.path, streamUdpConn, videoArg);
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

                    // Join voice channel
                    await streamer.joinVoice(guildId, channelId, streamOpts);

                    // Create stream
                    const streamLinkUdpConn = await streamer.createStream(streamOpts);

                    streamStatus.joined = true;
                    streamStatus.playing = true;
                    streamStatus.channelInfo = {
                        guildId: guildId,
                        channelId: channelId,
                        cmdChannelId: message.channel.id
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
                                    sendPlaying(message, videoInfo.videoDetails.title);
                                    playVideo(yturl, streamLinkUdpConn, videoInfo.videoDetails.title);
                                }
                            }
                            break;
                        default:
                            {
                                sendPlaying(message, "URL");
                                playVideo(link, streamLinkUdpConn, "URL");
                            }
                    }
                }
                break;
            case 'ytplay':
                {
                    if (streamStatus.joined) {
                        sendError(message, 'Already joined');
                        return;
                    }

                    const title = args.length > 1 ? args.slice(1).join(' ') : args[1] || args.shift() || '';

                    if (!title) {
                        await sendError(message, 'Please provide a video title.');
                        return;
                    }

                    // Join voice channel
                    await streamer.joinVoice(guildId, channelId, streamOpts);

                    // Create stream
                    const streamYoutubeTitleUdpConn = await streamer.createStream(streamOpts);

                    const [ytUrlFromTitle, searchResults] = await Promise.all([
                        ytPlayTitle(title),
                        yts.search(title, { limit: 1 })
                    ]);

                    streamStatus.joined = true;
                    streamStatus.playing = true;
                    streamStatus.channelInfo = {
                        guildId: guildId,
                        channelId: channelId,
                        cmdChannelId: message.channel.id
                    }

                    const videoResult = searchResults[0];
                    if (ytUrlFromTitle && videoResult?.title) {
                        sendPlaying(message, videoResult.title);
                        playVideo(ytUrlFromTitle, streamYoutubeTitleUdpConn, videoResult.title);
                    }
                }
                break;
            case 'ytsearch':
                {
                    const query = args.length > 1 ? args.slice(1).join(' ') : args[1] || args.shift() || '';

                    if (!query) {
                        await sendError(message, 'Please provide a search query.');
                        return;
                    }

                    const ytSearchQuery = await ytSearch(query);
                    try {
                        if (ytSearchQuery) {
                            await sendList(message, ytSearchQuery, "ytsearch");
                        }

                    } catch (error) {
                        await sendError(message, 'Failed to search for videos.');
                    }
                }
                break;
            case 'stop':
                {
                    if (!streamStatus.joined) {
                        sendError(message, '**Already Stopped!**');
                        return;
                    }

                    command?.cancel()

                    logger.info("Stopped playing")
                    sendSuccess(message, 'Stopped playing video');
                }
                break;
            case 'list':
                {
                    const videoList = videos.map((video, index) => `${index + 1}. \`${video.name}\``);
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
            case 'refresh':
                {
                    // Refresh video list
                    const videoFiles = readDirRecursive(config.videosDir);
                    videos = videoFiles.map(file => {
                        const fileName = path.parse(file).name;
                        // Replace space with _
                        return { name: fileName.replace(/ /g, '_'), path: file };
                    });
                    const refreshedList = videos.map((video, index) => `${index + 1}. \`${video.name}\``);
                    await sendPaginatedList(message, refreshedList);
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
                        `\`${config.prefix}ytplay\` - Play video from YouTube`,
                        `\`${config.prefix}stop\` - Stop playback`,
                        '',
                        '🛠️ **Utils**',
                        `\`${config.prefix}list\` - Show local videos, page scrolling stops after 2 minutes`,
                        `\`${config.prefix}refresh\` - Update the list based on any filesystem changes`,
                        `\`${config.prefix}status\` - Show status`,
                        '',
                        '🔍 **Search**',
                        `\`${config.prefix}ytsearch\` - YouTube search`,
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
async function playVideo(video: string, udpConn: MediaUdp, title?: string) {
    logger.info("Started playing video");
    udpConn.mediaConnection.setSpeaking(true);
    udpConn.mediaConnection.setVideoStatus(true);

    try {
        if (title) {
            streamer.client.user?.setActivity(status_watch(title) as ActivityOptions);
        }

        command = PCancelable.fn<string, string>(() => streamLivestreamVideo(video, udpConn))(video);

        const res = await command;
        logger.info(`Finished playing video: ${res}`);

    } catch (error) {
        if (!(error instanceof CancelError)) {
            logger.error("Error occurred while playing video:", error);
        }
    } finally {
        udpConn.mediaConnection.setSpeaking(false);
        udpConn.mediaConnection.setVideoStatus(false);
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
async function sendPlaying(message: Message, title: string) {
    const content = `📽 **Now Playing**: \`${title}\``;
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
async function sendCrash() {
    const channel = streamer.client.channels.cache.get(config.cmdChannelId.toString()) as TextChannel;
    if (channel) {
        channel.send(`❌ **I just crashed, shout at Sean**`);
    }
}

// Login to Discord
streamer.client.login(config.token);

// Clean up messages on app exit
process.on('exit', async () => {
    await sendCrash()
});

process.on('SIGINT', async () => {
    await sendCrash()
    process.exit();
});

process.on('SIGTERM', async () => {
    await sendCrash()
    process.exit();
});
