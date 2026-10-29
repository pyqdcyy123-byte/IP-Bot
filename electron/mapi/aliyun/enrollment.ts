import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import logger from '../log/main';
import { getFFmpegPath, getFFprobePath } from '../shell';
import { uploadToOss, getOssConfigFromProvider, OssConfig } from './oss';

const DASHSCOPE_API_URL = 'https://dashscope.aliyuncs.com/api/v1';
const MIN_ENROLLMENT_SAMPLE_RATE = 24000;
const execFileAsync = promisify(execFile);

async function ensureEnrollmentAudio(filePath: string): Promise<string> {
    if (!fs.existsSync(filePath)) {
        throw new Error(`文件不存在: ${filePath}`);
    }

    const ffprobePath = await getFFprobePath();
    const ffmpegPath = await getFFmpegPath();

    let sampleRate = 0;
    let channels = 0;
    try {
        const { stdout } = await execFileAsync(ffprobePath, [
            '-v', 'error',
            '-select_streams', 'a:0',
            '-show_entries', 'stream=sample_rate,channels',
            '-of', 'json',
            filePath,
        ]);
        const probe = JSON.parse(stdout || '{}');
        const stream = probe?.streams?.[0] || {};
        sampleRate = parseInt(stream.sample_rate || '0', 10) || 0;
        channels = parseInt(stream.channels || '0', 10) || 0;
    } catch (error: any) {
        logger.warn('[Aliyun:Enrollment] ffprobe 检测失败，直接转码兜底', {
            filePath,
            error: error.message,
        });
    }

    const needsConvert = !sampleRate || sampleRate < MIN_ENROLLMENT_SAMPLE_RATE || channels !== 1 || path.extname(filePath).toLowerCase() !== '.wav';
    if (!needsConvert) {
        logger.info('[Aliyun:Enrollment] 音频格式符合要求，直接使用', { filePath, sampleRate, channels });
        return filePath;
    }

    const parsed = path.parse(filePath);
    const normalizedPath = (p: string) => process.platform === 'win32' ? p.replace(/\\/g, '/') : p;
    const outputPath = path.join(parsed.dir, `${parsed.name}_enroll_24k.wav`);

    logger.info('[Aliyun:Enrollment] 开始转码复刻音频', {
        input: filePath,
        output: outputPath,
        sourceSampleRate: sampleRate,
        sourceChannels: channels,
        targetSampleRate: MIN_ENROLLMENT_SAMPLE_RATE,
        targetChannels: 1,
    });

    await execFileAsync(ffmpegPath, [
        '-y',
        '-i', normalizedPath(filePath),
        '-vn',
        '-acodec', 'pcm_s16le',
        '-ar', String(MIN_ENROLLMENT_SAMPLE_RATE),
        '-ac', '1',
        normalizedPath(outputPath),
    ]);

    logger.info('[Aliyun:Enrollment] 音频转码完成', { outputPath });
    return outputPath;
}

/**
 * 阿里云 DashScope Voice Enrollment (声音复刻) 服务
 */

/**
 * 获取复刻音频的可访问 URL
 * 配置了 OSS 时上传到 OSS 获取公网 URL；未配置时返回 Base64 Data URI（DashScope 声音复刻支持）
 */
export async function uploadFileToLease(apiKey: string, filePath: string, ossConfig?: OssConfig): Promise<string> {
    if (!fs.existsSync(filePath)) {
        throw new Error(`文件不存在: ${filePath}`);
    }

    const enrollmentAudioPath = await ensureEnrollmentAudio(filePath);

    // 优先使用传入的 OSS 配置，否则尝试从 Electron 系统配置获取
    let config = ossConfig;
    if (!config) {
        try {
            const { getElectronSystemConfigSync } = await import('../systemConfig');
            const systemConfig = getElectronSystemConfigSync();
            if (systemConfig?.aliyun_oss_access_key_id) {
                config = {
                    accessKeyId: systemConfig.aliyun_oss_access_key_id,
                    accessKeySecret: systemConfig.aliyun_oss_access_key_secret,
                    bucket: systemConfig.aliyun_oss_bucket,
                    region: systemConfig.aliyun_oss_region
                };
            }
        } catch (e) {
            logger.warn('[Aliyun:Enrollment] 获取系统OSS配置失败', e);
        }
    }

    if (!config) {
        // 未配置 OSS：使用 Base64 Data URI 提交（DashScope 声音复刻原生支持，无需公网 URL）
        const stats = fs.statSync(enrollmentAudioPath);
        if (stats.size > 10 * 1024 * 1024) {
            throw new Error('复刻音频超过 10MB 限制，请裁剪后重试');
        }

        const audioBuffer = fs.readFileSync(enrollmentAudioPath);
        logger.info('[Aliyun:Enrollment] 未配置 OSS，使用 Base64 Data URI 提交复刻音频', {
            filePath: enrollmentAudioPath,
            size: audioBuffer.length
        });
        return 'data:audio/wav;base64,' + audioBuffer.toString('base64');
    }

    logger.info('[Aliyun:Enrollment] 开始上传音频到 OSS', {
        filePath: enrollmentAudioPath,
        bucket: config.bucket,
        region: config.region
    });

    const ext = path.extname(enrollmentAudioPath);
    const objectKey = `voice-enrollment/${Date.now()}_${Math.random().toString(36).substring(2, 8)}${ext}`;

    const result = await uploadToOss(enrollmentAudioPath, config, objectKey);

    if (!result.success || !result.url) {
        throw new Error(`OSS 上传失败: ${result.error || '未知错误'}`);
    }

    logger.info('[Aliyun:Enrollment] OSS 上传成功，获取到公网 URL');
    return result.url;
}

// 废弃旧的 applyLease 和 uploadToOss 函数
// async function applyLease ... 
// async function uploadToOss ...

/*
interface LeaseResponse {
    url: string; // 用于后续API调用的文件URL
    param: {
        url: string; // 上传地址
        method: string;
        headers: any;
    };
    upload_method: string;
}

async function applyLease(apiKey: string, extension: string): Promise<LeaseResponse> {
    const url = `${DASHSCOPE_API_URL}/uploads`;
    const payload = {
        action: 'getPolicy', // 注意：DashScope不同服务的上传接口可能不同，这里使用通用的uploads/getPolicy ? 
        // 修正：DashScope有一个通用的 `uploads` 接口用于申请 lease
        // 文档: POST https://dashscope.aliyuncs.com/api/v1/uploads
        model: 'voice-enrollment' // 指定模型
    };

    try {
        const response = await axios.get(url, {
            params: payload,
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            }
        });

        // 响应结构:
        // {
        //   "data": {
        //     "url": "https://...",
        //     "param": { ... },
        //     "upload_method": "PUT" / "POST"
        //   }
        // }

        if (response.data && response.data.data) {
            const data = response.data.data;
            logger.info('[Aliyun:Enrollment] Apply Lease 响应:', JSON.stringify(data));

            // 适配 OSS PostObject 格式
            // https://help.aliyun.com/zh/oss/developer-reference/postobject
            if (data.policy && data.signature && data.upload_host) {
                // 构造文件名（使用随机UUID或保留原扩展名）
                // 上传后的 URL = upload_host + / + upload_dir + / + filename
                // 但是 DashScope 可能要求特定的 key 格式？
                // data.upload_dir 是前缀。
                // 我们需要自己生成 key。

                return {
                    url: '', // 这里的 URL 需要在上传后拼接，或者 DashScope 不需要? 
                    // 文档说 create_voice 需要 public url.
                    // OSS PostObject 不会自动返回 URL。
                    // 通常是 upload_host + '/' + key
                    param: {
                        url: data.upload_host,
                        method: 'POST',
                        headers: {}, // PostObject 不需要 Authorization header，签名在 body 里
                        formData: {
                            'key': data.upload_dir + '/${filename}', // 这是一个模板，实际上传时替换
                            'policy': data.policy,
                            'Signature': data.signature,
                            'OSSAccessKeyId': data.oss_access_key_id,
                            'x-oss-object-acl': data.x_oss_object_acl,
                            'x-oss-forbid-overwrite': data.x_oss_forbid_overwrite,
                            // 'file': ... (在 uploadToOss 中添加)
                        },
                        // 用于拼接最终 URL
                        uploadDir: data.upload_dir,
                        uploadHost: data.upload_host
                    },
                    upload_method: 'POST'
                } as LeaseResponse; // 临时通过 any 绕过类型检查，稍后修正 Interface
            }

            // 兼容性处理：如果 param 不存在，可能是扁平结构，或者结构有所不同
            if (!data.param) {
                // 如果没有 param，看看有没有 url
                if (data.url) {
                    // 构造一个伪 param
                    return {
                        url: data.url,
                        upload_method: data.upload_method || 'POST', // 默认 POST?
                        param: {
                            url: data.url,
                            method: data.upload_method || 'PUT', // 大多数预签名URL是PUT
                            headers: data.headers || {} // 扁平结构可能有 headers
                        }
                    } as LeaseResponse;
                }
            }
            return data as LeaseResponse;
        } else {
            logger.error('[Aliyun:Enrollment] Apply Lease 响应异常:', JSON.stringify(response.data));
            throw new Error('申请上传凭证失败: ' + JSON.stringify(response.data));
        }

    } catch (error: any) {
        logger.error('[Aliyun:Enrollment] Apply Lease 失败', error.response?.data || error.message);
        throw error;
    }
}

async function uploadToOss(filePath: string, param: any): Promise<string> {
    const fileBuffer = fs.existsSync(filePath) ? fs.readFileSync(filePath) : null;
    if (!fileBuffer) throw new Error(`文件读取失败: ${filePath}`);

    const fileName = path.basename(filePath);

    try {
        const method = param.method || 'PUT';
        logger.info(`[Aliyun:Enrollment] 上传文件到临时存储 URL: ${param.url}`);

        if (method.toUpperCase() === 'POST' && param.formData) {
            logger.info('[Aliyun:Enrollment] 使用 FormData (OSS PostObject) 上传');

            // 使用 Node.js 全局 FormData (Node 18+)
            // 如果环境不支持，这里会报错。Electron 29 (Node 20) 应该支持。
            const FormDataClass = (global as any).FormData;
            if (!FormDataClass) {
                throw new Error('当前环境不支持全局 FormData，无法执行 POST 上传');
            }

            const form = new FormDataClass();

            // 构造 Key (FilePath in OSS)
            // 上面的 param.formData['key'] 是个模板: .../${filename}
            // 我们生成一个唯一文件名，或者直接用 fileName
            const finalKey = param.formData['key'].replace('${filename}', fileName);

            // 必须按照顺序添加吗？OSS 对顺序通常不敏感，但 file 最好在最后
            form.append('key', finalKey);
            form.append('policy', param.formData['policy']);
            form.append('Signature', param.formData['Signature']);
            form.append('OSSAccessKeyId', param.formData['OSSAccessKeyId']);
            if (param.formData['x-oss-object-acl']) form.append('x-oss-object-acl', param.formData['x-oss-object-acl']);
            if (param.formData['x-oss-forbid-overwrite']) form.append('x-oss-forbid-overwrite', param.formData['x-oss-forbid-overwrite']);

            // 添加文件
            // Node.js 的 FormData 需要 Blob 或 File。
            // 我们可以用 Blob (Node 18+)
            const BlobClass = (global as any).Blob;
            if (!BlobClass) {
                throw new Error('当前环境不支持全局 Blob');
            }
            const blob = new BlobClass([fileBuffer]);
            form.append('file', blob, fileName);

            // 发送请求
            // axios 在 Node 中支持传入 FormData 实例，并自动设置 headers (Content-Type: multipart/form-data; boundary=...)
            await axios.post(param.url, form, {
                headers: {
                    // 让 axios/FormData 自动计算 Content-Type
                    // 'Content-Type': 'multipart/form-data' // 不要手动设置，否则丢失 boundary
                }
            });

            // 更新 leaseData.url，因为 PostObject 不会返回，我们需要自己算
            // param 是引用传递吗？不是，这里是 uploadToOss。
            // 我们需要一种方式把 URL 传回去。
            // 这里我们无法修改外部的 leaseData。
            // 所以 uploadToOss 应该返回 url。

            const objectUrl = `${param.uploadHost}/${finalKey}`;
            logger.info(`[Aliyun:Enrollment] OSS 上传成功, URL: ${objectUrl}`);
            return objectUrl;
        }

        // PUT 逻辑保持不变
        else if (method.toUpperCase() === 'PUT') {
            logger.info(`[Aliyun:Enrollment] 上传 Method: ${method}, Headers:`, param.headers);
            await axios.put(param.url, fileBuffer, {
                headers: param.headers || {}
            });
            logger.info('[Aliyun:Enrollment] 上传 OSS 成功');
            return param.url.split('?')[0]; // 去除签名参数得到纯URL? 不一定，视情况而定
        } else {
            logger.warn(`[Aliyun:Enrollment] 未知上传方法: ${method}, 尝试 Generic Request`);
            await axios({
                method: method,
                url: param.url,
                headers: param.headers,
                data: fileBuffer
            });
            logger.info('[Aliyun:Enrollment] 上传 OSS 成功');
            return param.url.split('?')[0]; // 假设通用请求也返回带签名的URL
        }

    } catch (error: any) {
        // 详细错误日志
        const errInfo = {
            status: error.response?.status,
            statusText: error.response?.statusText,
            data: error.response?.data,
            headers: error.response?.headers,
            message: error.message
        };
        logger.error('[Aliyun:Enrollment] 上传 OSS 失败', JSON.stringify(errInfo));
        throw error;
    }
}
*/

/**
 * 创建复刻音色
 */
export async function createVoice(apiKey: string, audioUrl: string, prefix: string = 'custom_voice'): Promise<string> {
    const url = `${DASHSCOPE_API_URL}/services/audio/tts/customization`;

    const payload = {
        model: 'voice-enrollment',
        input: {
            action: 'create_voice',
            target_model: 'cosyvoice-v3.5-plus',
            prefix: prefix,
            url: audioUrl
        }
    };

    logger.info('[Aliyun:Enrollment] 开始复刻音色', payload);

    try {
        const response = await axios.post(url, payload, {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            }
        });

        const data = response.data;
        const voiceId = data.output?.voice || data.output?.voice_id;
        if (voiceId) {
            logger.info('[Aliyun:Enrollment] 复刻成功', data.output);
            return voiceId;
        } else {
            throw new Error('复刻响应格式错误: ' + JSON.stringify(data));
        }
    } catch (error: any) {
        logger.error('[Aliyun:Enrollment] 复刻失败', error.response?.data || error.message);
        throw error;
    }
}
