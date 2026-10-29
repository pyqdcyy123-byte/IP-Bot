/**
 * 瀑布流网格辅助（纯函数）。
 * studio-creation-grid 用「小行高单元 + grid-row span」实现各列高度解耦：
 * 伸缩某个面板时其它列自动上移补位，不再出现整行联动的大空洞。
 */

function computeRowSpan(height, rowUnit, rowGap) {
    const step = rowUnit + rowGap;
    if (step <= 0) return 1;
    return Math.max(1, Math.ceil((height + rowGap) / step));
}

module.exports = { computeRowSpan };
