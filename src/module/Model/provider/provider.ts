import {ProviderType} from "../types";
import {OpenAiModelProvider} from "./driver/openai";
import {mapError} from "../../../lib/error";
import {buildChatCompletionsUrl} from "./chat-url.cjs";

const ModelProviderMap = {
    openai: OpenAiModelProvider,
};

export type ModelChatResult = {
    code: number;
    msg: string;
    data?: {
        content?: string;
        [key: string]: any;
    };
};

export const ModelProvider = {
    apiUrl(type: ProviderType, apiUrl: string, apiHost: string = "") {
        let url = apiUrl;
        if (apiHost) {
            url = apiHost;
        }
        // console.log('ModelProvider.apiUrl', {type, apiUrl, apiHost, url});
        switch (type) {
            case "openai":
                // 拼接规则委托给共享模块（支持版本号结尾的地址，如火山 Ark /api/coding/v3）
                return buildChatCompletionsUrl(url);
        }
        throw new Error(`Unsupported provider type: ${type}`);
    },
    async chat(
        prompt: string,
        config: {
            type: ProviderType;
            modelId: string;
            apiUrl: string;
            apiHost: string;
            apiKey: string;
        }
    ): Promise<ModelChatResult> {
        let url = this.apiUrl(config.type, config.apiUrl, config.apiHost);

        if (!(config.type in ModelProviderMap)) {
            return {
                code: -1,
                msg: `Unsupported provider type: ${config.type}`,
            };
        }
        const provider = new ModelProviderMap[config.type]({
            ...config,
            url,
        });
        try {
            return provider.chat(prompt);
        } catch (e) {
            return {
                code: -1,
                msg: `Request failed: ${mapError(e)}`,
            };
        }
    },
};
