import Response from '@/lib/response/Response.ts';
import images from "./images.ts";
import ping from "./ping.ts";
import token from './token.js';
import models from './models.ts';
import videos from './videos.ts';
import tasks from './tasks.ts';

export default [
    {
        get: {
            '/': async () => {
                return {
                    service: 'jimeng-cli',
                    status: 'running',
                    version: '1.6.3',
                    description: '免费的AI图像和视频生成API服务 - 基于即梦AI的逆向工程实现',
                    documentation: 'https://github.com/iptag/jimeng-cli',
                    endpoints: {
                        images: '/v1/images/generations',
                        compositions: '/v1/images/compositions',
                        videos: '/v1/videos/generations',
                        tasks: '/v1/tasks/:task_id',
                        tokenPool: '/token/pool',
                        models: '/v1/models',
                        health: '/ping'
                    }
                };
            }
        }
    },
    images,
    ping,
    token,
    models,
    videos,
    tasks
];
