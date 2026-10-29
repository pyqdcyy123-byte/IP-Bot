<script setup lang="ts">
import {computed, ref, watch} from "vue";
import {useModelStore} from "./store/model";
import ProviderAddDialog from "./components/ProviderAddDialog.vue";
import ProviderEditDialog from "./components/ProviderEditDialog.vue";
import {getProviderUrl} from "./providers";
import ModelAddDialog from "./components/ModelAddDialog.vue";
import ModelEditDialog from "./components/ModelEditDialog.vue";
import ProviderTestDialog from "./components/ProviderTestDialog.vue";
import {getModelLogo} from "./models";
import {useUserStore} from "../../store/modules/user";
import {useSettingStore} from "../../store/modules/setting";
import {Dialog} from "../../lib/dialog";

const userStore = useUserStore();
const setting = useSettingStore();
const modelStore = useModelStore();
const providerAdd = ref<InstanceType<typeof ProviderAddDialog> | null>(null);
const providerEdit = ref<InstanceType<typeof ProviderEditDialog> | null>(null);
const modelAdd = ref<InstanceType<typeof ModelAddDialog> | null>(null);
const modelEdit = ref<InstanceType<typeof ModelEditDialog> | null>(null);
const providerTest = ref<InstanceType<typeof ProviderTestDialog> | null>(null);
const doUser = async () => {
    if (!setting.basic.userEnable) {
        return;
    }
    await window.$mapi.user.open({
        readyParam: {
            page: "ChargeLmApi",
        },
    });
};

const keywords = ref("");
const currentProviderId = ref("");
const builtinCustomModel = ref({
    id: "",
    name: "",
});

const doSelectProvider = (id: string) => {
    currentProviderId.value = id;
};
const provider = computed(() => {
    return modelStore.providers.find(p => p.id === currentProviderId.value);
});
const providerUrl = computed(() => {
    return getProviderUrl(provider.value as any);
});
const canAddBuiltinCustomModel = computed(() => {
    return provider.value?.id === "builtInDoubao";
});
const providerModelGroups = computed(() => {
    if (!provider.value) {
        return [];
    }
    const models = provider.value.data.models;
    const groups = models.map(m => m.group).filter((v, i, a) => a.indexOf(v) === i);
    return groups.map(g => {
        return {
            group: g,
            models: models.filter(m => m.group === g),
        };
    });
});
const providersFilter = computed(() => {
    return modelStore.providers.filter(p => {
        if (keywords.value) {
            return p.title.toLowerCase().includes(keywords.value.toLowerCase());
        }
        return true;
    });
});

// 简化后的分组：推荐模型（内置）+ 我的模型（自定义/云端）
const recommendedProviders = computed(() => {
    return providersFilter.value.filter(p => p.isBuiltIn && p.id === 'builtInDoubao');
});

const myProviders = computed(() => {
    return providersFilter.value.filter(p => {
        // 排除系统内置
        if (p.id === 'buildIn') return false;
        // 排除不需要的builtin
        if (p.id === 'builtInAliyun') return false;
        // 排除未启用的builtin（除非是推荐的那个）
        if (p.isBuiltIn && p.id !== 'builtInDoubao') return false;
        return true;
    });
});
watch(
    () => modelStore.providers,
    () => {
        if (!currentProviderId.value && modelStore.providers.length > 0) {
            // 🔧 自动选择第一个provider时，跳过 builtInAliyun
            const firstProvider = modelStore.providers.find(p => p.id !== 'builtInAliyun');
            if (firstProvider) {
                doSelectProvider(firstProvider.id);
            }
        }
    },
    {immediate: true}
);
const addBuiltinCustomModel = async () => {
    const id = builtinCustomModel.value.id.trim();
    const name = builtinCustomModel.value.name.trim();
    if (!canAddBuiltinCustomModel.value) {
        return;
    }
    if (!id || !name) {
        Dialog.tipError("请填写模型Key和模型名称");
        return;
    }
    const added = await modelStore.modelAdd("builtInDoubao", {
        id,
        name,
        group: "自定义模型",
        types: ["text"],
        editable: true,
    });
    if (added) {
        builtinCustomModel.value.id = "";
        builtinCustomModel.value.name = "";
        Dialog.tipSuccess("模型已添加，可在智能体设置中直接选择");
    }
};
</script>

<template>
    <div class="model-setting-shell flex h-full bg-[#0a0a0a]">
        <div class="model-setting-sidebar w-56 border-r border-[#333] flex flex-col flex-shrink-0 bg-[#141414]">
            <div class="p-2">
                <a-input :placeholder="$t('搜索模型平台')" v-model="keywords" class="dark-input">
                    <template #suffix>
                        <icon-search/>
                    </template>
                </a-input>
            </div>
            <div class="flex-grow p-2 overflow-x-hidden overflow-y-auto">
                <div v-if="!providersFilter.length && modelStore.providers.length">
                    <a-empty :description="$t('没有找到相关模型平台')"/>
                </div>

                <!-- 推荐模型（内置） -->
                <div v-if="recommendedProviders.length > 0">
                    <div class="text-xs font-bold text-gray-400 px-3 py-2 mb-1">⚡ {{ $t("推荐") }}</div>
                    <div v-for="p in recommendedProviders" :key="p.id">
                        <div
                            class="provider-nav-item flex hover:bg-[#1a1a1a] cursor-pointer border border-transparent rounded-full mb-2 px-3 py-2 items-center"
                            :class="currentProviderId === p.id ? 'provider-nav-item-active bg-[#1a1a1a] border-[#444]' : ''"
                            @click="doSelectProvider(p.id)"
                        >
                            <div class="mr-2">
                                <img v-if="p.logo"
                                     class="w-[20px] h-[20px] rounded"
                                     style="background:#333;border:1px solid #444;"
                                     :src="p.logo"/>
                                <a-avatar v-else :size="20" shape="square"
                                          :style="{backgroundColor: '#3370ff'}">
                                    {{ p.title }}
                                </a-avatar>
                            </div>
                            <div class="flex-grow text-gray-200 text-sm">
                                {{ p.title }}
                            </div>
                            <div v-if="p.data.enabled">
                                <icon-check-circle class="text-green-600 text-xs"/>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- 我的模型（自定义+云端） -->
                <div v-if="myProviders.length > 0">
                    <div class="text-xs font-bold text-gray-400 px-3 py-2 mb-1">📁 {{ $t("我的模型") }}</div>
                    <div v-for="p in myProviders" :key="p.id">
                        <div
                            class="provider-nav-item flex hover:bg-[#1a1a1a] cursor-pointer border border-transparent rounded-full mb-2 px-3 py-2 items-center"
                            :class="currentProviderId === p.id ? 'provider-nav-item-active bg-[#1a1a1a] border-[#444]' : ''"
                            @click="doSelectProvider(p.id)"
                        >
                            <div class="mr-2">
                                <img v-if="p.logo"
                                     class="w-[20px] h-[20px] rounded"
                                     style="background:#333;border:1px solid #444;"
                                     :src="p.logo"/>
                                <a-avatar v-else :size="20" shape="square"
                                          :style="{backgroundColor: p.isServerPush ? '#10b981' : '#3370ff'}">
                                    {{ p.isServerPush ? '☁' : p.title }}
                                </a-avatar>
                            </div>
                            <div class="flex-grow text-gray-200 text-sm">
                                {{ p.title }}
                            </div>
                            <div v-if="p.data.enabled">
                                <icon-check-circle class="text-green-600 text-xs"/>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            <div class="p-2">
                <a-button class="w-full" @click="providerAdd?.show()">
                    {{ $t("添加") }}
                    <template #icon>
                        <icon-plus/>
                    </template>
                </a-button>
            </div>
        </div>
        <div class="model-setting-content flex-grow overflow-y-auto overflow-x-hidden bg-[#0a0a0a]">
            <div class="py-20" v-if="!provider">
                <a-empty :description="$t('请选择模型平台')"/>
            </div>
            <div v-else class="p-4">
                <!-- 头部信息栏 -->
                <div class="provider-header flex items-center border-b border-[#333] pb-3 mb-4">
                    <div class="font-bold text-lg mr-3 text-gray-200">
                        {{ provider.title }}
                    </div>
                    <div class="flex-grow">
                        <a
                            v-if="!provider.isSystem && !provider.isBuiltIn && !provider.isServerPush"
                            href="javascript:;"
                            class="text-gray-400 hover:text-blue-400 mr-3"
                            @click="providerEdit?.show(provider)"
                        >
                            <icon-edit class="mr-1"/> 编辑
                        </a>
                    </div>
                    <div class="flex items-center">
                        <span class="text-gray-400 mr-2 text-sm">启用</span>
                        <a-switch
                            :model-value="provider.data.enabled"
                            @change="modelStore.change(provider.id, 'data.enabled', $event)"
                        />
                    </div>
                </div>

                <!-- 内置/云端推送提示 -->
                <div class="mb-4 flex border rounded-lg p-3 items-center" 
                     :class="provider.isBuiltIn ? 'bg-green-900/20 border-green-700' : provider.isServerPush ? 'bg-blue-900/20 border-blue-700' : ''"
                     v-if="provider.isBuiltIn || provider.isServerPush">
                    <icon-check v-if="provider.isBuiltIn" class="text-green-500 mr-2 flex-shrink-0"/>
                    <icon-cloud v-if="provider.isServerPush" class="text-blue-400 mr-2 flex-shrink-0"/>
                    <span class="text-sm text-gray-300">
                        {{ provider.isBuiltIn ? '内置模型无需配置可直接使用' : '此供应商由管理员统一推送，API密钥由服务端管理' }}
                    </span>
                </div>

                <!-- 添加自定义模型（豆包） -->
                <div class="builtin-model-add-panel mb-4" v-if="canAddBuiltinCustomModel">
                    <div class="builtin-model-add-title">➕ 添加自定义模型</div>
                    <div class="builtin-model-add-grid">
                        <a-input
                            v-model:model-value="builtinCustomModel.id"
                            placeholder="模型 Key"
                        />
                        <a-input
                            v-model:model-value="builtinCustomModel.name"
                            placeholder="模型名称"
                        />
                        <a-button type="primary" @click="addBuiltinCustomModel">
                            <template #icon>
                                <icon-plus/>
                            </template>
                            添加
                        </a-button>
                    </div>
                </div>

                <!-- API配置区（非内置和云端） -->
                <div class="mb-4" v-if="!provider.isBuiltIn && !provider.isServerPush && provider.id !== 'dashscope'">
                    <div class="section-title mb-3">🔑 API配置</div>
                    <div class="space-y-3">
                        <div>
                            <div class="label mb-1">API密钥</div>
                            <a-input-password
                                :model-value="provider.data.apiKey"
                                @input="modelStore.change(provider.id, 'data.apiKey', $event)"
                                class="w-full"
                                placeholder="输入 API Key"
                            >
                                <template #suffix>
                                    <a href="javascript:;" @click="providerTest?.show()" class="text-blue-400 hover:text-blue-300">
                                        检查
                                    </a>
                                </template>
                            </a-input-password>
                        </div>
                        <div>
                            <div class="label mb-1">API地址 <span class="text-gray-500 text-xs">(可选)</span></div>
                            <a-input
                                :model-value="provider.data.apiHost"
                                @input="modelStore.change(provider.id, 'data.apiHost', $event)"
                                class="w-full"
                                placeholder="留空使用默认地址"
                            >
                            </a-input>
                            <div class="text-xs text-gray-500 mt-1" v-if="providerUrl">
                                默认：{{ providerUrl }}
                            </div>
                        </div>
                    </div>
                </div>

                <!-- 内置能量显示 -->
                <div class="mb-4 flex border border-[#333] rounded-lg p-3 items-center bg-[#141414]" 
                     v-if="provider.id === 'buildIn'">
                    <div class="flex-grow">
                        <span class="text-gray-400 mr-2">剩余能量:</span>
                        <span class="font-bold text-lg text-green-400">{{ ((userStore.data.lmApi?.quota || 0) / 1000).toFixed(2) }}K</span>
                    </div>
                    <a-button type="primary" @click="doUser" size="small">
                        充值
                    </a-button>
                </div>

                <!-- 模型列表 -->
                <div class="mb-3">
                    <div class="section-title mb-3 flex items-center justify-between">
                        <span>🤖 模型列表</span>
                        <a-button 
                            size="mini" 
                            @click="modelAdd?.show()" 
                            v-if="!provider.isBuiltIn && provider.id !== 'buildIn' && !provider.isServerPush">
                            <template #icon>
                                <icon-plus/>
                            </template>
                            添加模型
                        </a-button>
                    </div>

                    <!-- 简洁的模型卡片网格 -->
                    <div class="grid grid-cols-1 gap-2">
                        <div
                            v-for="m in provider?.data.models || []"
                            :key="m.id"
                            class="model-card flex items-center p-3 rounded-lg border"
                            :class="m.enabled ? 'border-[#333] bg-[#141414]' : 'border-[#333] bg-[#0f0f0f] opacity-60'"
                        >
                            <a-avatar
                                :image-url="getModelLogo(m.id)"
                                :size="24"
                                shape="square"
                                class="mr-3 flex-shrink-0"
                                style="border: 1px solid #444"
                            />
                            <div class="flex-grow">
                                <div class="text-gray-200 text-sm font-medium">{{ m.name }}</div>
                                <div class="text-gray-500 text-xs">{{ m.id }}</div>
                            </div>
                            <div class="flex items-center gap-2">
                                <a-switch
                                    v-if="provider.id !== 'buildIn'"
                                    :model-value="m.enabled"
                                    @change="modelStore.changeModel(provider.id, m.id, 'enabled', $event)"
                                    size="small"
                                ></a-switch>
                                <a-button 
                                    size="mini" 
                                    @click="modelEdit?.show(m)" 
                                    v-if="provider.id !== 'buildIn' && m.editable !== false"
                                    title="编辑">
                                    <icon-settings/>
                                </a-button>
                                <a-button 
                                    size="mini" 
                                    @click="modelStore.modelDelete(provider.id, m.id)" 
                                    v-if="provider.id !== 'buildIn' && m.editable !== false"
                                    title="删除">
                                    <icon-delete/>
                                </a-button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>
    <ProviderAddDialog ref="providerAdd"/>
    <ProviderEditDialog ref="providerEdit"/>
    <ModelAddDialog ref="modelAdd" :provider="provider"/>
    <ModelEditDialog ref="modelEdit" :provider="provider"/>
    <ProviderTestDialog ref="providerTest" :provider="provider"/>
</template>

<style scoped>
.model-setting-shell {
    background: #f5f7fb;
    color: #111827;
}

.model-setting-sidebar {
    background: #f8fafc;
    border-color: #e5e7eb;
}

.model-setting-content {
    background: #ffffff;
}

.provider-nav-item {
    border-color: transparent;
    background: transparent;
    transition: all 0.2s ease;
}

.provider-nav-item:hover {
    background: #eef4ff !important;
    border-color: #c7d2fe !important;
}

.provider-nav-item-active {
    background: #e0e7ff !important;
    border-color: #a5b4fc !important;
}

.provider-header {
    border-color: #e5e7eb;
}

.builtin-provider-tip {
    background: #ecfdf3 !important;
    border-color: #86efac !important;
}

.builtin-model-add-panel {
    border: 1px solid #c7d2fe;
    background: #eef4ff;
    border-radius: 8px;
    padding: 12px;
}

.builtin-model-add-title {
    font-size: 13px;
    font-weight: 600;
    color: #1e3a8a;
    margin-bottom: 8px;
}

.builtin-model-add-grid {
    display: grid;
    grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) auto;
    gap: 8px;
    align-items: center;
}

.builtin-model-add-tip {
    margin-top: 8px;
    font-size: 11px;
    color: #475569;
}

.model-card {
    border-color: #2a2a2a !important;
    background: #1a1a1a !important;
    transition: all 0.15s ease;
}

.model-card:hover {
    border-color: #3a3a3a !important;
    background: #1f1f1f !important;
}

.model-card :deep(.arco-avatar) {
    background: #2a2a2a !important;
}

.section-title {
    font-size: 13px;
    font-weight: 600;
    color: #374151;
}

.label {
    font-size: 12px;
    color: #6b7280;
    font-weight: 500;
}

.space-y-3 > * + * {
    margin-top: 12px;
}

.grid {
    display: grid;
}

.grid-cols-1 {
    grid-template-columns: repeat(1, minmax(0, 1fr));
}

.gap-2 {
    gap: 8px;
}

.grid-cols-2 {
    grid-template-columns: repeat(2, minmax(0, 1fr));
}

.gap-3 {
    gap: 12px;
}

.model-setting-shell :deep(.arco-input-wrapper),
.model-setting-shell :deep(.arco-input-number),
.model-setting-shell :deep(.arco-select-view),
.model-setting-shell :deep(.arco-btn-secondary),
.model-setting-shell :deep(.arco-textarea-wrapper) {
    background: #ffffff;
    border-color: #d1d5db;
}

.model-setting-shell :deep(.arco-input-wrapper:hover),
.model-setting-shell :deep(.arco-select-view:hover),
.model-setting-shell :deep(.arco-input-number:hover) {
    border-color: #94a3b8;
}

.model-setting-shell :deep(.arco-input),
.model-setting-shell :deep(.arco-select-view-value),
.model-setting-shell :deep(.arco-btn),
.model-setting-shell :deep(.arco-collapse-item-header-title) {
    color: #111827;
}

.model-setting-shell :deep(.arco-collapse-item-header) {
    background: #f8fafc;
    border-radius: 10px;
}

.model-setting-shell :deep(.arco-empty-description),
.model-setting-shell .text-gray-500 {
    color: #64748b !important;
}

.model-setting-shell .text-gray-400 {
    color: #475569 !important;
}

.model-setting-shell .text-gray-300,
.model-setting-shell .text-gray-200 {
    color: #111827 !important;
}
</style>
