import type {
  VideoRecorderCapabilities,
  VideoRecorderOverlayLayout,
  VideoRecorderSettings,
} from "./videoRecorder.types";

const PREFERRED_MIME_TYPES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm;codecs=h264,opus",
  "video/webm",
  "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
  "video/mp4",
];

const FALLBACK_MIME_TYPE = "video/webm";

export const DEFAULT_VIDEO_RECORDER_CAMERA_LAYOUT: VideoRecorderOverlayLayout =
  {
    x: 0.72,
    y: 0.67,
    width: 0.24,
    height: 0.24,
    shape: "rounded",
  };

export const getVideoRecorderCapabilities = (): VideoRecorderCapabilities => {
  if (typeof window === "undefined") {
    return {
      isSupported: false,
      reason: "window-not-available",
      supportedMimeTypes: [],
    };
  }

  if (typeof MediaRecorder === "undefined") {
    return {
      isSupported: false,
      reason: "media-recorder-not-supported",
      supportedMimeTypes: [],
    };
  }

  if (typeof MediaRecorder.isTypeSupported !== "function") {
    return {
      isSupported: false,
      reason: "mime-type-detection-not-supported",
      supportedMimeTypes: [],
    };
  }

  const supportedMimeTypes = PREFERRED_MIME_TYPES.filter((mimeType) => {
    try {
      return MediaRecorder.isTypeSupported(mimeType);
    } catch {
      return false;
    }
  });

  if (!supportedMimeTypes.length) {
    return {
      isSupported: false,
      reason: "no-supported-mime-type",
      supportedMimeTypes: [],
    };
  }

  return {
    isSupported: true,
    supportedMimeTypes,
  };
};

export const getDefaultVideoRecorderSettings = (): VideoRecorderSettings => {
  const capabilities = getVideoRecorderCapabilities();
  return {
    cameraEnabled: false,
    microphoneEnabled: true,
    selectedVideoDeviceId: null,
    selectedAudioDeviceId: null,
    aspectRatio: "16:9",
    resolution: "1080p",
    fps: 30,
    mimeType:
      capabilities.supportedMimeTypes[0] ||
      (capabilities.isSupported ? FALLBACK_MIME_TYPE : ""),
    camera: { ...DEFAULT_VIDEO_RECORDER_CAMERA_LAYOUT },
    teleprompter: {
      enabled: false,
      text: "",
      opacity: 0.75,
      speed: 35,
    },
  };
};
