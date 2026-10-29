/**
 * RunningHub v2 AI 应用接口的任务参数构建（纯函数，无 Electron 依赖）
 * 供 client.ts 与 tests/runninghub-v2-payload.test.cjs 共用。
 *
 * 节点配置项支持可选 value 字段：
 *  - { id, fieldName }          → 使用该节点的历史默认值（fps=30, width=576, height=1024, maxSide=1024, audioStart=0, duration/audioEnd=ceil(audioDuration)）
 *  - { id, fieldName, value }   → 使用配置值，支持 {{audioDuration}} 占位符（替换为向上取整的音频秒数）
 */

/** 插值：把 fieldValue 里的 {{audioDuration}} 替换为向上取整的音频秒数 */
function interpolate(fieldValue, audioDuration) {
  const seconds = Math.ceil(Number(audioDuration) || 0);
  return String(fieldValue).replace(/\{\{audioDuration\}\}/g, String(seconds));
}

function entry(node, fieldValue, description) {
  // 兼容两种节点形状：配置格式 {id, fieldName} 与 client.ts resolveNode 输出 {nodeId, fieldName}
  return { nodeId: node.id ?? node.nodeId, fieldName: node.fieldName, fieldValue, description };
}

/**
 * 构建 v2 接口的 nodeInfoList
 * @param {object} nodes 节点配置（videoNode/audioNode 必填，其余可选，extraNodes 为数组）
 * @param {object} params { videoFileName, audioFileName, audioDuration?, text? }
 * @returns {Array<{nodeId:string,fieldName:string,fieldValue:string,description:string}>}
 */
function buildV2NodeInfoList(nodes, params) {
  const { videoFileName, audioFileName, audioDuration, text } = params;
  const list = [];

  list.push(entry(nodes.videoNode, videoFileName, '请导入视频'));
  list.push(entry(nodes.audioNode, audioFileName, '请导入新的音频'));

  if (audioDuration && nodes.durationNode) {
    const value = nodes.durationNode.value !== undefined
      ? interpolate(nodes.durationNode.value, audioDuration)
      : String(Math.ceil(audioDuration));
    list.push(entry(nodes.durationNode, value, '视频时长设置（秒）'));
  }

  if (nodes.fpsNode) {
    list.push(entry(nodes.fpsNode, nodes.fpsNode.value !== undefined ? String(nodes.fpsNode.value) : '30', '视频帧率'));
  }

  if (nodes.widthNode) {
    list.push(entry(nodes.widthNode, nodes.widthNode.value !== undefined ? String(nodes.widthNode.value) : '576', '视频宽度'));
  }

  if (nodes.heightNode) {
    list.push(entry(nodes.heightNode, nodes.heightNode.value !== undefined ? String(nodes.heightNode.value) : '1024', '视频高度'));
  }

  if (nodes.maxSideNode) {
    list.push(entry(nodes.maxSideNode, nodes.maxSideNode.value !== undefined ? String(nodes.maxSideNode.value) : '1024', '最长边'));
  }

  if (nodes.audioStartNode) {
    list.push(entry(nodes.audioStartNode, nodes.audioStartNode.value !== undefined ? String(nodes.audioStartNode.value) : '0', '音频开始秒数'));
  }

  if (nodes.audioEndNode && audioDuration) {
    const value = nodes.audioEndNode.value !== undefined
      ? interpolate(nodes.audioEndNode.value, audioDuration)
      : String(Math.ceil(audioDuration));
    list.push(entry(nodes.audioEndNode, value, '音频结束秒数'));
  }

  if (nodes.textNode && text) {
    list.push(entry(nodes.textNode, text, '提示词'));
  }

  // 通用额外节点：适配任意 AI 应用的其它参数节点，fieldValue 支持 {{audioDuration}}
  if (Array.isArray(nodes.extraNodes)) {
    for (const extra of nodes.extraNodes) {
      if (!extra || !extra.nodeId || !extra.fieldName) continue;
      list.push({
        nodeId: String(extra.nodeId),
        fieldName: String(extra.fieldName),
        fieldValue: interpolate(extra.fieldValue ?? '', audioDuration),
        description: '参数覆盖'
      });
    }
  }

  return list;
}

module.exports = { buildV2NodeInfoList, interpolate };
