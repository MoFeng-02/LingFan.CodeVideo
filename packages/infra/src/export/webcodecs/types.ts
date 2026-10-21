/**
 * WebCodecs 导出适配器的参数。
 *
 * 参数只描述输出尺寸与码率；真正的编码/封装细节见同目录的 `video-track`、
 * `audio-track`，错误接力与背压见上一层的 `encoder-gate`。
 */

/** WebCodecs 导出参数 */
export interface WebCodecsExporterOptions {
  /** 输出宽（像素）；也是编码器 `codedWidth`，位图帧的尺寸必须与之一致 */
  width: number;
  /** 输出高（像素）；也是编码器 `codedHeight`，位图帧的尺寸必须与之一致 */
  height: number;
  /** 视频帧率声明（仅用于编码器提示；实际时间戳来自帧） */
  fps: number;
  /** 视频码率（bps），缺省 8Mbps */
  bitrate?: number;
  /** 音频码率（bps），缺省 128kbps */
  audioBitrate?: number;
}
