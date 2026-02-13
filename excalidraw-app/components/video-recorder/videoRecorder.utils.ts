import type {
  VideoRecorderAspectRatio,
  VideoRecorderOverlayLayout,
  VideoRecorderResolution,
} from "./videoRecorder.types";

export const VIDEO_RECORDER_RATIO_MAP: Record<
  VideoRecorderAspectRatio,
  number
> = {
  "16:9": 16 / 9,
  "4:3": 4 / 3,
  "1:1": 1,
  "9:16": 9 / 16,
};

const RESOLUTION_BASE: Record<VideoRecorderResolution, number> = {
  "720p": 720,
  "1080p": 1080,
};

export const getVideoDimensions = (
  aspectRatio: VideoRecorderAspectRatio,
  resolution: VideoRecorderResolution,
) => {
  const ratio = VIDEO_RECORDER_RATIO_MAP[aspectRatio];
  const base = RESOLUTION_BASE[resolution];

  if (ratio >= 1) {
    return {
      width: Math.round(base * ratio),
      height: base,
    };
  }

  return {
    width: base,
    height: Math.round(base / ratio),
  };
};

export const clamp = (value: number, min: number, max: number) => {
  return Math.max(min, Math.min(max, value));
};

export const clampOverlayLayout = (
  layout: VideoRecorderOverlayLayout,
): VideoRecorderOverlayLayout => {
  const width = clamp(layout.width, 0.1, 0.8);
  const height = clamp(layout.height, 0.1, 0.8);
  return {
    ...layout,
    width,
    height,
    x: clamp(layout.x, 0, 1 - width),
    y: clamp(layout.y, 0, 1 - height),
  };
};

export const normalizedRectToPixels = (
  layout: VideoRecorderOverlayLayout,
  width: number,
  height: number,
) => {
  return {
    x: Math.round(layout.x * width),
    y: Math.round(layout.y * height),
    width: Math.round(layout.width * width),
    height: Math.round(layout.height * height),
  };
};

export const getFileExtensionFromMimeType = (mimeType: string) => {
  if (mimeType.includes("mp4")) {
    return "mp4";
  }
  return "webm";
};
