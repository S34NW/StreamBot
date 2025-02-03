import ffmpeg from "fluent-ffmpeg"

// Checking video params
export async function getVideoParams(videoPath: string): Promise<{ width: number, height: number, bitrate: string, maxbitrate: string, fps: number, length: any }> {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(videoPath, (err, metadata) => {
            if (err) {
                return reject(err);
            }

            const videoStream = metadata.streams.find(stream => stream.codec_type === 'video');

            if (videoStream && videoStream.width && videoStream.height && videoStream.bit_rate) {
                const rFrameRate = videoStream.r_frame_rate || videoStream.avg_frame_rate;

                if (rFrameRate) {
                    const [numerator, denominator] = rFrameRate.split('/').map(Number);
                    videoStream.fps = numerator / denominator;
                } else {
                    videoStream.fps = 0
                }

                resolve({ width: videoStream.width, height: videoStream.height, bitrate: videoStream.bit_rate, maxbitrate: videoStream.maxBitrate, fps: videoStream.fps, length: metadata.format.duration });
            } else {
                reject(new Error('Unable to get Resolution.'));
            }
        });
    });
}

