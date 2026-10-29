<script setup lang="ts">
import {useModelStore} from "./store/model";
import {computed, ref} from "vue";
import {getModelLogo} from "./models";

const props = defineProps<{
    modelValue?: string;  // v-model 绑定的值
    providerFilter?: string;  // 限定只显示指定提供商的模型，如 "builtInDoubao"
}>();

const emit = defineEmits<{
    (e: 'update:modelValue', value: string): void;
}>();

type ModelRecord = {
    providerId: string;
    providerTitle: string;
    modelId: string;
    modelName: string;
};
const model = useModelStore();
const availableModels = computed(() => {
    const models: ModelRecord[] = [];
    for (const p of model.providers) {
        if (!p.data.enabled) {
            continue;
        }
        // 如果指定了提供商过滤，则只显示该提供商的模型（管理员推送的供应商不受限制）
        if (props.providerFilter && p.id !== props.providerFilter && !p.isServerPush) {
            continue;
        }
        for (const m of p.data.models) {
            if (!m.enabled) {
                continue;
            }
            // 🔧 修复：过滤掉非文本模型
            // 只显示：
            // 1. types 包含 'text' 的模型
            // 2. 没有 types 字段的模型（默认为文本模型）
            // 排除：
            // 🔧 修复：过滤掉非文本模型
            // 只显示：
            // 1. types 包含 'text' 的模型
            // 2. 没有 types 字段的模型（默认为文本模型）
            // 排除：
            // - types 包含 'asr'（语音识别）
            // - types 包含 'voice-clone'（语音合成）
            // - types 包含 'digital-human'（数字人）
            if (m.types && Array.isArray(m.types)) {
                if (m.types.includes('asr') || m.types.includes('voice-clone') || m.types.includes('digital-human')) {
                    continue; // 跳过非文本模型
                }
                if (!m.types.includes('text')) {
                    continue; // 如果有types字段但不包含text，也跳过
                }
            }
            models.push({
                providerId: p.id,
                providerTitle: p.title,
                modelId: m.id,
                modelName: m.name,
            } as ModelRecord);
        }
    }
    return models;
});
const select = ref<any>(null);
const internalValue = computed({
    get: () => props.modelValue || '',
    set: (val: string) => emit('update:modelValue', val)
});
const selectedProvider = computed(() => {
    const val = internalValue.value;
    if (val) {
        const [providerId, modelId] = val.split("|");
        for (const p of model.providers) {
            if (p.id === providerId) {
                return p;
            }
        }
    }
    return null;
});
const selectedModel = computed(() => {
    const val = internalValue.value;
    if (!val) return null;
    const [providerId, modelId] = val.split("|");
    if (!selectedProvider.value) {
        return null;
    }
    for (const m of selectedProvider.value.data.models) {
        if (m.id === modelId) {
            return m;
        }
    }
    return null;
});
defineExpose({
    getInfo: () => {
        return {
            providerLogo: getModelLogo(selectedModel.value?.id || ''),
            providerTitle: selectedProvider.value?.title || '',
            modelName: selectedModel.value?.name || '',
        };
    },
});
</script>

<template>
    <a-select ref="select" style="width:auto;" :placeholder="$t('选择模型')"
              :model-value="internalValue"
              @change="internalValue = $event">
        <template #label>
            <div class="flex items-center" v-if="selectedProvider && selectedModel">
                <div class="mr-1">
                    <a-avatar
                        :image-url="getModelLogo(selectedModel.id)"
                        :size="20"
                        shape="square"
                        style="border: 1px solid #ccc"
                    />
                </div>
                <div class="mr-1">
                    {{ selectedProvider?.title }}
                </div>
                <div class="mr-1 text-gray-400">/</div>
                <div>
                    {{ selectedModel.name }}
                </div>
            </div>
            <div class="flex items-center" v-else>
                <div class="mr-1">
                    {{ $t("选择模型") }}
                </div>
            </div>
        </template>
        <a-option v-for="p in availableModels" :value="p.providerId + '|' + p.modelId">
            <div class="flex items-center">
                <div class="mr-1">
                    <a-avatar
                        :image-url="getModelLogo(p.modelId)"
                        :size="20"
                        shape="square"
                        style="border: 1px solid #ccc"
                    />
                </div>
                <div class="mr-1">
                    {{ p.providerTitle }}
                </div>
                <div class="mr-1 text-gray-400">/</div>
                <div>
                    {{ p.modelName }}
                </div>
            </div>
        </a-option>
    </a-select>
</template>
