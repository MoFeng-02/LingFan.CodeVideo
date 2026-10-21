/**
 * WebM（Matroska 子集）用到的元素 ID 常量。
 *
 * 元素 ID 在 EBML 里本身就是变长整数形态（首字节的前导零个数就是它的字节数），
 * 所以这里直接写规范给的十六进制值，由 `ebml.ts` 按原样转成字节。
 *
 * 只收录本模块实际写出的元素；未列出的元素说明这条导出路径不产出它们
 * （例如 SeekHead、Tags、Chapters）。
 */

/** EBML 头（文件起始的元信息块） */
export const EBML = 0x1a45dfa3;
/** EBML 版本 */
export const EBML_VERSION = 0x4286;
/** EBML 读取方要求的最低版本 */
export const EBML_READ_VERSION = 0x42f7;
/** ID 最大字节数（本模块固定写 4） */
export const EBML_MAX_ID_LENGTH = 0x42f2;
/** 长度字段最大字节数（本模块固定写 8） */
export const EBML_MAX_SIZE_LENGTH = 0x42f3;
/** 文档类型（WebM 固定 "webm"） */
export const DOC_TYPE = 0x4282;
/** 文档类型版本 */
export const DOC_TYPE_VERSION = 0x4287;
/** 文档类型最低读取版本 */
export const DOC_TYPE_READ_VERSION = 0x4285;

/** 段（整个媒体数据的容器） */
export const SEGMENT = 0x18538067;
/** 段信息（时间刻度、时长、封装程序标识） */
export const INFO = 0x1549a966;
/** 时间刻度：一个时间码单位折多少纳秒 */
export const TIMECODE_SCALE = 0x2ad7b1;
/** 时长（以时间码单位计，浮点） */
export const DURATION = 0x4489;
/** 封装程序名 */
export const MUXING_APP = 0x4d80;
/** 写入程序名 */
export const WRITING_APP = 0x5741;

/** 轨道表 */
export const TRACKS = 0x1654ae6b;
/** 单条轨道 */
export const TRACK_ENTRY = 0xae;
/** 轨道编号（块里用它指向轨道） */
export const TRACK_NUMBER = 0xd7;
/** 轨道唯一标识 */
export const TRACK_UID = 0x73c5;
/** 轨道类型（1 = 视频，2 = 音频） */
export const TRACK_TYPE = 0x83;
/** 编解码器标识（如 "V_VP9"、"A_OPUS"） */
export const CODEC_ID = 0x86;
/** 编解码器私有数据（Opus 放 OpusHead） */
export const CODEC_PRIVATE = 0x63a2;
/** 默认每帧时长（纳秒） */
export const DEFAULT_DURATION = 0x23e383;

/** 视频轨参数 */
export const VIDEO = 0xe0;
/** 像素宽 */
export const PIXEL_WIDTH = 0xb0;
/** 像素高 */
export const PIXEL_HEIGHT = 0xba;
/** 透明模式（1 = 这一轨携带 alpha 附加块） */
export const ALPHA_MODE = 0x53c0;

/** 音频轨参数 */
export const AUDIO = 0xe1;
/** 采样率（浮点，赫兹） */
export const SAMPLING_FREQUENCY = 0xb5;
/** 声道数 */
export const CHANNELS = 0x9f;
/** 位深 */
export const BIT_DEPTH = 0x6264;

/** 簇（一组块，簇内含相对时间码） */
export const CLUSTER = 0x1f43b675;
/** 簇时间码（时间码单位） */
export const TIMECODE = 0xe7;
/** 简单块：不带附加数据的块 */
export const SIMPLE_BLOCK = 0xa3;
/** 块组：需要携带附加数据（如 alpha）时用它包一个块 */
export const BLOCK_GROUP = 0xa0;
/** 块（块组内的主体） */
export const BLOCK = 0xa1;
/** 附加数据集合 */
export const BLOCK_ADDITIONS = 0x75a1;
/** 一条附加数据 */
export const BLOCK_MORE = 0xa6;
/** 附加数据编号（1 = alpha） */
export const BLOCK_ADD_ID = 0xee;
/** 附加数据本体 */
export const BLOCK_ADDITIONAL = 0xa5;
/** 参考块（非关键帧指向它依赖的帧） */
export const REFERENCE_BLOCK = 0xfb;

/** 索引表（让播放器能跳转） */
export const CUES = 0x1c53bb6b;
/** 一个索引点 */
export const CUE_POINT = 0xbb;
/** 索引点对应的簇时间码 */
export const CUE_TIME = 0xb3;
/** 索引点在轨道内的位置 */
export const CUE_TRACK_POSITIONS = 0xb7;
/** 索引点指向的轨道编号 */
export const CUE_TRACK = 0xf7;
/** 索引点指向的簇在段负载内的字节偏移 */
export const CUE_CLUSTER_POSITION = 0xf1;
