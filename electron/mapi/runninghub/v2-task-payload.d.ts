export interface V2NodeInfoItem {
  nodeId: string;
  fieldName: string;
  fieldValue: string;
  description: string;
}

export interface V2NodeSpec {
  id: string;
  fieldName?: string;
  value?: string | number;
}

export interface V2ExtraNode {
  nodeId: string;
  fieldName: string;
  fieldValue: string | number;
}

export function buildV2NodeInfoList(
  nodes: {
    videoNode: V2NodeSpec;
    audioNode: V2NodeSpec;
    durationNode?: V2NodeSpec;
    fpsNode?: V2NodeSpec;
    widthNode?: V2NodeSpec;
    heightNode?: V2NodeSpec;
    maxSideNode?: V2NodeSpec;
    audioStartNode?: V2NodeSpec;
    audioEndNode?: V2NodeSpec;
    textNode?: V2NodeSpec;
    extraNodes?: V2ExtraNode[];
  },
  params: { videoFileName: string; audioFileName: string; audioDuration?: number; text?: string }
): V2NodeInfoItem[];
