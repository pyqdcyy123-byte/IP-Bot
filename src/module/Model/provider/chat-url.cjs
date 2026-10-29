/**
 * OpenAI 兼容接口的 chat/completions URL 拼接（纯函数，供前端多处复用）
 *
 * 规则：
 *  - 以 '/' 结尾            → 直接追加 chat/completions
 *  - 已含 /chat/completions → 原样返回
 *  - 以 /v1、/v3 等版本号结尾 → 追加 /chat/completions（版本已在地址里，不能再拼 /v1）
 *  - 其余                   → 追加 /v1/chat/completions（历史默认，如裸域名）
 */

function buildChatCompletionsUrl(url) {
    if (url.endsWith('/')) {
        return `${url}chat/completions`;
    }
    if (url.endsWith('/chat/completions')) {
        return url;
    }
    if (/\/v\d+$/.test(url)) {
        return `${url}/chat/completions`;
    }
    return `${url}/v1/chat/completions`;
}

module.exports = { buildChatCompletionsUrl };
