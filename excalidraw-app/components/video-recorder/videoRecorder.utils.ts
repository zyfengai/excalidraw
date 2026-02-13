import type {
  VideoRecorderAspectRatio,
  VideoRecorderOverlayLayout,
  VideoRecorderResolution,
  VideoRecorderSettings,
} from "./videoRecorder.types";

export const VIDEO_RECORDER_SUPPORTED_ASPECT_RATIOS = [
  "16:9",
  "4:3",
  "1:1",
  "9:16",
] as const;
export const VIDEO_RECORDER_SUPPORTED_RESOLUTIONS = ["720p", "1080p"] as const;
export const VIDEO_RECORDER_SUPPORTED_FPS = [24, 30, 60] as const;

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
const DEFAULT_VIDEO_RECORDER_ASPECT_RATIO: VideoRecorderAspectRatio = "16:9";
const DEFAULT_VIDEO_RECORDER_RESOLUTION: VideoRecorderResolution = "1080p";

export const normalizeRecorderAspectRatio = (
  candidateAspectRatio: string,
  fallbackAspectRatio: VideoRecorderAspectRatio,
): VideoRecorderAspectRatio =>
  VIDEO_RECORDER_SUPPORTED_ASPECT_RATIOS.some(
    (aspectRatio) => aspectRatio === candidateAspectRatio.trim(),
  )
    ? (candidateAspectRatio.trim() as VideoRecorderAspectRatio)
    : fallbackAspectRatio;

export const normalizeRecorderResolution = (
  candidateResolution: string,
  fallbackResolution: VideoRecorderResolution,
): VideoRecorderResolution => {
  const normalizedCandidateResolution = candidateResolution
    .trim()
    .toLowerCase();
  const matchedResolution = VIDEO_RECORDER_SUPPORTED_RESOLUTIONS.find(
    (resolution) => resolution.toLowerCase() === normalizedCandidateResolution,
  );
  return matchedResolution || fallbackResolution;
};

export const getVideoDimensions = (
  aspectRatio: VideoRecorderAspectRatio,
  resolution: VideoRecorderResolution,
) => {
  const normalizedAspectRatio = normalizeRecorderAspectRatio(
    aspectRatio,
    DEFAULT_VIDEO_RECORDER_ASPECT_RATIO,
  );
  const normalizedResolution = normalizeRecorderResolution(
    resolution,
    DEFAULT_VIDEO_RECORDER_RESOLUTION,
  );
  const ratio = VIDEO_RECORDER_RATIO_MAP[normalizedAspectRatio];
  const base = RESOLUTION_BASE[normalizedResolution];

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

export const normalizeRecorderFps = (
  candidateFps: number,
  fallbackFps: number,
) => {
  const minFps = VIDEO_RECORDER_SUPPORTED_FPS[0];
  const maxFps =
    VIDEO_RECORDER_SUPPORTED_FPS[VIDEO_RECORDER_SUPPORTED_FPS.length - 1];
  const normalizeToSupportedPreset = (fps: number) =>
    VIDEO_RECORDER_SUPPORTED_FPS.reduce((closest, current) => {
      if (Math.abs(current - fps) < Math.abs(closest - fps)) {
        return current;
      }
      return closest;
    }, VIDEO_RECORDER_SUPPORTED_FPS[0]);

  const safeFallback = Number.isFinite(fallbackFps)
    ? normalizeToSupportedPreset(clamp(Math.round(fallbackFps), minFps, maxFps))
    : 30;
  const baseFps = Number.isFinite(candidateFps)
    ? clamp(Math.round(candidateFps), minFps, maxFps)
    : safeFallback;

  return normalizeToSupportedPreset(baseFps);
};

export const clampOverlayLayout = (
  layout: VideoRecorderOverlayLayout,
): VideoRecorderOverlayLayout => {
  const normalizedWidth = clamp(layout.width, 0.1, 0.8);
  const normalizedHeight = clamp(layout.height, 0.1, 0.8);
  const width =
    layout.shape === "circle"
      ? Math.max(normalizedWidth, normalizedHeight)
      : normalizedWidth;
  const height = layout.shape === "circle" ? width : normalizedHeight;
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
  const normalizedMimeType = mimeType.toLowerCase();
  if (normalizedMimeType.includes("mp4")) {
    return "mp4";
  }
  return "webm";
};

const canonicalizeMimeType = (mimeType: string) =>
  mimeType
    .trim()
    .toLowerCase()
    .replace(/\s*;\s*/g, ";")
    .replace(/\s*=\s*/g, "=")
    .replace(/\s*,\s*/g, ",");

export const normalizeRecorderMimeType = (
  candidateMimeType: string,
  supportedMimeTypes: string[],
) => {
  const normalizedCandidateMimeType = canonicalizeMimeType(candidateMimeType);
  if (!normalizedCandidateMimeType) {
    return supportedMimeTypes[0] || "";
  }

  const exactMatch = supportedMimeTypes.find(
    (mimeType) =>
      canonicalizeMimeType(mimeType) === normalizedCandidateMimeType,
  );
  if (exactMatch) {
    return exactMatch;
  }
  return supportedMimeTypes[0] || "";
};

export const getPermissionRequestConstraints = (
  settings: VideoRecorderSettings,
): MediaStreamConstraints => {
  const fallbackPermissionRequest =
    !settings.cameraEnabled && !settings.microphoneEnabled;
  const shouldRequestVideo =
    settings.cameraEnabled ||
    (!settings.cameraEnabled && !settings.microphoneEnabled);
  const shouldRequestAudio =
    settings.microphoneEnabled ||
    (!settings.cameraEnabled && !settings.microphoneEnabled);

  return {
    video: shouldRequestVideo
      ? !fallbackPermissionRequest && settings.selectedVideoDeviceId
        ? { deviceId: { exact: settings.selectedVideoDeviceId } }
        : true
      : false,
    audio: shouldRequestAudio
      ? !fallbackPermissionRequest && settings.selectedAudioDeviceId
        ? { deviceId: { exact: settings.selectedAudioDeviceId } }
        : true
      : false,
  };
};
