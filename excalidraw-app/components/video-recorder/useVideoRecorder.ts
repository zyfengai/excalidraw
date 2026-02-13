import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { EVENT } from "@excalidraw/common";
import { t } from "@excalidraw/excalidraw/i18n";

import {
  getDefaultVideoRecorderSettings,
  getVideoRecorderCapabilities,
} from "./videoRecorder.config";
import {
  loadVideoRecorderSettings,
  saveVideoRecorderSettings,
} from "./videoRecorder.storage";
import {
  clampOverlayLayout,
  getFileExtensionFromMimeType,
  getPermissionRequestConstraints,
  getVideoDimensions,
  normalizeRecorderMimeType,
  normalizedRectToPixels,
} from "./videoRecorder.utils";

import type {
  VideoRecorderCapabilities,
  VideoRecorderDeviceOption,
  VideoRecorderOverlayLayout,
  VideoRecorderResult,
  VideoRecorderSettings,
  VideoRecorderStatus,
} from "./videoRecorder.types";

const MEDIA_RECORDER_TIMESLICE_MS = 1000;
const STOP_RECORDING_TIMEOUT_MS = 3000;
const INVALID_FILE_NAME_CHARS = /[\\/:*?"<>|]/g;
const MAX_RECORDING_FILE_NAME_LENGTH = 120;
const TRAILING_RECORDING_FILE_EXTENSION = /(?:\.(?:webm|mp4))+$/i;
const WINDOWS_RESERVED_FILE_NAME =
  /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

class StartRecordingCancelledError extends Error {}

const isDeviceSelectionError = (error: unknown) =>
  error instanceof DOMException &&
  (error.name === "NotFoundError" || error.name === "OverconstrainedError");

const getUserMediaWithDeviceFallback = async (
  primaryConstraints: MediaStreamConstraints,
  fallbackConstraints?: MediaStreamConstraints,
  onFallbackFromSelectionError?: () => void,
) => {
  try {
    return await navigator.mediaDevices.getUserMedia(primaryConstraints);
  } catch (error) {
    if (!fallbackConstraints || !isDeviceSelectionError(error)) {
      throw error;
    }
    onFallbackFromSelectionError?.();
    return navigator.mediaDevices.getUserMedia(fallbackConstraints);
  }
};

const hasSpecificDeviceConstraint = (
  constraint: MediaTrackConstraints | boolean | undefined,
) => {
  if (!constraint || typeof constraint === "boolean") {
    return false;
  }

  const { deviceId } = constraint;
  if (!deviceId) {
    return false;
  }

  if (typeof deviceId === "string") {
    return deviceId.length > 0;
  }

  if (Array.isArray(deviceId)) {
    return deviceId.length > 0;
  }

  return "exact" in deviceId && !!deviceId.exact;
};

const reconcileSelectedDeviceId = (
  selectedDeviceId: string | null,
  availableDevices: VideoRecorderDeviceOption[],
  shouldPreserveWhenDeviceTypeMissing: boolean,
) => {
  if (!selectedDeviceId) {
    return selectedDeviceId;
  }

  if (availableDevices.length === 0) {
    return shouldPreserveWhenDeviceTypeMissing ? selectedDeviceId : null;
  }

  const exists = availableDevices.some(
    (device) => device.deviceId === selectedDeviceId,
  );
  return exists ? selectedDeviceId : null;
};

const stopMediaStreamsTracksOnce = (
  ...streams: Array<MediaStream | null | undefined>
) => {
  const tracksToStop = new Set<MediaStreamTrack>();
  streams.forEach((stream) => {
    stream?.getTracks().forEach((track) => tracksToStop.add(track));
  });
  tracksToStop.forEach((track) => track.stop());
};

const getExcalidrawCanvases = () => {
  const staticCanvas = document.querySelector<HTMLCanvasElement>(
    ".excalidraw canvas.static",
  );
  const interactiveCanvas = document.querySelector<HTMLCanvasElement>(
    ".excalidraw canvas.interactive",
  );

  if (!staticCanvas || !interactiveCanvas) {
    throw new Error(t("videoRecorder.errors.canvasNotFound"));
  }

  return {
    staticCanvas,
    interactiveCanvas,
  };
};

const drawCanvasContain = (
  context: CanvasRenderingContext2D,
  source: HTMLCanvasElement,
  targetWidth: number,
  targetHeight: number,
) => {
  const sourceWidth = source.width;
  const sourceHeight = source.height;

  if (!sourceWidth || !sourceHeight) {
    return;
  }

  const scale = Math.min(
    targetWidth / sourceWidth,
    targetHeight / sourceHeight,
  );
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  const offsetX = (targetWidth - drawWidth) / 2;
  const offsetY = (targetHeight - drawHeight) / 2;

  context.drawImage(source, offsetX, offsetY, drawWidth, drawHeight);
};

const applyRoundedClip = (
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) => {
  const clippedRadius = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + clippedRadius, y);
  context.lineTo(x + width - clippedRadius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + clippedRadius);
  context.lineTo(x + width, y + height - clippedRadius);
  context.quadraticCurveTo(
    x + width,
    y + height,
    x + width - clippedRadius,
    y + height,
  );
  context.lineTo(x + clippedRadius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - clippedRadius);
  context.lineTo(x, y + clippedRadius);
  context.quadraticCurveTo(x, y, x + clippedRadius, y);
  context.closePath();
  context.clip();
};

const drawCameraOverlay = ({
  context,
  cameraVideo,
  targetWidth,
  targetHeight,
  layout,
}: {
  context: CanvasRenderingContext2D;
  cameraVideo: HTMLVideoElement;
  targetWidth: number;
  targetHeight: number;
  layout: VideoRecorderOverlayLayout;
}) => {
  if (
    !cameraVideo.videoWidth ||
    !cameraVideo.videoHeight ||
    cameraVideo.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
  ) {
    return;
  }

  const { x, y, width, height } = normalizedRectToPixels(
    layout,
    targetWidth,
    targetHeight,
  );

  context.save();
  if (layout.shape === "circle") {
    const radius = Math.min(width, height) / 2;
    context.beginPath();
    context.arc(x + width / 2, y + height / 2, radius, 0, Math.PI * 2);
    context.clip();
  } else if (layout.shape === "rounded") {
    applyRoundedClip(context, x, y, width, height, Math.max(12, width * 0.1));
  }
  context.drawImage(cameraVideo, x, y, width, height);
  context.restore();
};

const collectMediaDevices = async () => {
  if (!navigator.mediaDevices?.enumerateDevices) {
    return {
      videoInputs: [] as VideoRecorderDeviceOption[],
      audioInputs: [] as VideoRecorderDeviceOption[],
    };
  }

  const devices = await navigator.mediaDevices.enumerateDevices();

  const formatLabel = (label: string, fallback: string, idx: number) => {
    if (label?.trim()) {
      return label;
    }
    return `${fallback} ${idx + 1}`;
  };

  const videoInputs = devices
    .filter((device) => device.kind === "videoinput")
    .map((device, idx) => ({
      deviceId: device.deviceId,
      label: formatLabel(device.label, "Camera", idx),
    }));

  const audioInputs = devices
    .filter((device) => device.kind === "audioinput")
    .map((device, idx) => ({
      deviceId: device.deviceId,
      label: formatLabel(device.label, "Microphone", idx),
    }));

  return {
    videoInputs,
    audioInputs,
  };
};

export const mapVideoRecorderErrorMessage = (error: unknown) => {
  if (error instanceof DOMException) {
    switch (error.name) {
      case "NotAllowedError":
      case "SecurityError":
        return t("videoRecorder.errors.permissionDenied");
      case "NotSupportedError":
        return t("videoRecorder.errors.notSupported");
      case "NotFoundError":
      case "OverconstrainedError":
        return t("videoRecorder.errors.deviceNotFound");
      case "NotReadableError":
      case "AbortError":
        return t("videoRecorder.errors.deviceBusy");
      default:
        return error.message || t("videoRecorder.errors.recordingFailed");
    }
  }

  if (error instanceof Error) {
    return error.message || t("videoRecorder.errors.recordingFailed");
  }
  return t("videoRecorder.errors.recordingFailed");
};

const sanitizeRecordingFileName = (name: string) => {
  const normalizedName = name
    .trim()
    .replace(TRAILING_RECORDING_FILE_EXTENSION, "");

  const sanitized = normalizedName
    .trim()
    .replace(INVALID_FILE_NAME_CHARS, "-")
    .replace(/\s+/g, " ")
    .replace(/-+/g, "-")
    .replace(/^[-.\s]+|[-.\s]+$/g, "")
    .slice(0, MAX_RECORDING_FILE_NAME_LENGTH)
    .replace(/^[-.\s]+|[-.\s]+$/g, "");

  if (WINDOWS_RESERVED_FILE_NAME.test(sanitized)) {
    return "excalidraw-recording";
  }

  return sanitized || "excalidraw-recording";
};

type UseVideoRecorderReturn = {
  capabilities: VideoRecorderCapabilities;
  settings: VideoRecorderSettings;
  status: VideoRecorderStatus;
  error: string | null;
  isDialogOpen: boolean;
  elapsedMs: number;
  result: VideoRecorderResult | null;
  devices: {
    videoInputs: VideoRecorderDeviceOption[];
    audioInputs: VideoRecorderDeviceOption[];
  };
  isRecordingActive: boolean;
  isRequestingPermissions: boolean;
  setDialogOpen: (open: boolean) => void;
  setSettings: (
    next:
      | Partial<VideoRecorderSettings>
      | ((prev: VideoRecorderSettings) => VideoRecorderSettings),
  ) => void;
  updateCameraLayout: (
    next:
      | Partial<VideoRecorderOverlayLayout>
      | ((prev: VideoRecorderOverlayLayout) => VideoRecorderOverlayLayout),
  ) => void;
  refreshDevices: () => Promise<void>;
  requestMediaPermissions: () => Promise<void>;
  startRecording: () => Promise<void>;
  pauseRecording: () => void;
  resumeRecording: () => void;
  stopRecording: () => Promise<void>;
  resetResult: () => void;
  downloadRecording: (name: string) => void;
};

export const useVideoRecorder = (): UseVideoRecorderReturn => {
  const capabilities = useMemo(() => getVideoRecorderCapabilities(), []);

  const [settings, setSettingsState] = useState<VideoRecorderSettings>(() => {
    const defaults = getDefaultVideoRecorderSettings();
    const loaded = loadVideoRecorderSettings();
    const mimeType = normalizeRecorderMimeType(
      loaded.mimeType || defaults.mimeType || "",
      capabilities.supportedMimeTypes,
    );

    return {
      ...defaults,
      ...loaded,
      mimeType,
    };
  });
  const [status, setStatus] = useState<VideoRecorderStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [isDialogOpen, setDialogOpen] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [result, setResult] = useState<VideoRecorderResult | null>(null);
  const [isRequestingPermissions, setIsRequestingPermissions] = useState(false);
  const [devices, setDevices] = useState<{
    videoInputs: VideoRecorderDeviceOption[];
    audioInputs: VideoRecorderDeviceOption[];
  }>({
    videoInputs: [],
    audioInputs: [],
  });

  const renderFrameRef = useRef<number | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordingStreamRef = useRef<MediaStream | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const microphoneStreamRef = useRef<MediaStream | null>(null);
  const compositionCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const cameraVideoRef = useRef<HTMLVideoElement | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef<number | null>(null);
  const pausedAtRef = useRef<number | null>(null);
  const pausedAccumulatedRef = useRef<number>(0);
  const elapsedTimerRef = useRef<number | null>(null);
  const permissionRequestInFlightRef = useRef(false);
  const startRecordingInFlightRef = useRef(false);
  const startRecordingRequestIdRef = useRef(0);
  const refreshDevicesRequestIdRef = useRef(0);
  const stopRecordingInFlightRef = useRef(false);
  const stopRecordingTimeoutRef = useRef<number | null>(null);
  const stopRecordingFinalizeRef = useRef<(() => void) | null>(null);
  const isMountedRef = useRef(true);

  const clearElapsedTimer = useCallback(() => {
    if (elapsedTimerRef.current != null) {
      window.clearInterval(elapsedTimerRef.current);
      elapsedTimerRef.current = null;
    }
  }, []);

  const cleanupStreams = useCallback(() => {
    if (stopRecordingTimeoutRef.current != null) {
      window.clearTimeout(stopRecordingTimeoutRef.current);
      stopRecordingTimeoutRef.current = null;
    }

    if (stopRecordingFinalizeRef.current) {
      const finalizeStop = stopRecordingFinalizeRef.current;
      stopRecordingFinalizeRef.current = null;
      finalizeStop();
    }

    if (renderFrameRef.current != null) {
      cancelAnimationFrame(renderFrameRef.current);
      renderFrameRef.current = null;
    }

    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onerror = null;
      recorder.onstop = null;
    }

    stopMediaStreamsTracksOnce(
      recordingStreamRef.current,
      cameraStreamRef.current,
      microphoneStreamRef.current,
    );
    recordingStreamRef.current = null;
    cameraStreamRef.current = null;
    microphoneStreamRef.current = null;

    if (cameraVideoRef.current) {
      cameraVideoRef.current.pause();
      cameraVideoRef.current.srcObject = null;
      cameraVideoRef.current = null;
    }

    compositionCanvasRef.current = null;
    clearElapsedTimer();
    stopRecordingInFlightRef.current = false;
    startRecordingInFlightRef.current = false;
    permissionRequestInFlightRef.current = false;
    startRecordingRequestIdRef.current += 1;
  }, [clearElapsedTimer]);

  const refreshDevices = useCallback(async () => {
    const requestId = refreshDevicesRequestIdRef.current + 1;
    refreshDevicesRequestIdRef.current = requestId;

    try {
      const mediaDevices = await collectMediaDevices();
      if (
        !isMountedRef.current ||
        requestId !== refreshDevicesRequestIdRef.current
      ) {
        return;
      }
      setDevices(mediaDevices);
      setSettingsState((prev) => {
        const hasVideoInputs = mediaDevices.videoInputs.length > 0;
        const hasAudioInputs = mediaDevices.audioInputs.length > 0;
        const selectedVideoDeviceId = reconcileSelectedDeviceId(
          prev.selectedVideoDeviceId,
          mediaDevices.videoInputs,
          !hasAudioInputs || !prev.cameraEnabled,
        );
        const selectedAudioDeviceId = reconcileSelectedDeviceId(
          prev.selectedAudioDeviceId,
          mediaDevices.audioInputs,
          !hasVideoInputs || !prev.microphoneEnabled,
        );

        if (
          selectedVideoDeviceId === prev.selectedVideoDeviceId &&
          selectedAudioDeviceId === prev.selectedAudioDeviceId
        ) {
          return prev;
        }

        return {
          ...prev,
          selectedVideoDeviceId,
          selectedAudioDeviceId,
        };
      });
    } catch (deviceError) {
      if (
        !isMountedRef.current ||
        requestId !== refreshDevicesRequestIdRef.current
      ) {
        return;
      }
      console.error(deviceError);
    }
  }, []);

  const requestMediaPermissions = useCallback(async () => {
    if (!isMountedRef.current) {
      return;
    }

    if (permissionRequestInFlightRef.current) {
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setError(t("videoRecorder.errors.notSupported"));
      return;
    }

    setError(null);
    permissionRequestInFlightRef.current = true;
    setIsRequestingPermissions(true);
    try {
      const requestedVideoDeviceId = settings.selectedVideoDeviceId;
      const requestedAudioDeviceId = settings.selectedAudioDeviceId;
      const primaryConstraints = getPermissionRequestConstraints(settings);
      const shouldClearVideoSelection = hasSpecificDeviceConstraint(
        primaryConstraints.video,
      );
      const shouldClearAudioSelection = hasSpecificDeviceConstraint(
        primaryConstraints.audio,
      );
      const isDualSpecificSelectionRequest =
        shouldClearVideoSelection && shouldClearAudioSelection;
      const shouldFallbackToDefaultDevices =
        shouldClearVideoSelection || shouldClearAudioSelection;
      const stream = await getUserMediaWithDeviceFallback(
        primaryConstraints,
        shouldFallbackToDefaultDevices
          ? {
              video: !!primaryConstraints.video,
              audio: !!primaryConstraints.audio,
            }
          : undefined,
        () => {
          if (!isMountedRef.current) {
            return;
          }
          setSettingsState((prev) => {
            const selectedVideoDeviceId =
              !isDualSpecificSelectionRequest &&
              prev.cameraEnabled &&
              shouldClearVideoSelection &&
              requestedVideoDeviceId &&
              prev.selectedVideoDeviceId === requestedVideoDeviceId
                ? null
                : prev.selectedVideoDeviceId;
            const selectedAudioDeviceId =
              !isDualSpecificSelectionRequest &&
              prev.microphoneEnabled &&
              shouldClearAudioSelection &&
              requestedAudioDeviceId &&
              prev.selectedAudioDeviceId === requestedAudioDeviceId
                ? null
                : prev.selectedAudioDeviceId;

            if (
              selectedVideoDeviceId === prev.selectedVideoDeviceId &&
              selectedAudioDeviceId === prev.selectedAudioDeviceId
            ) {
              return prev;
            }

            return {
              ...prev,
              selectedVideoDeviceId,
              selectedAudioDeviceId,
            };
          });
        },
      );
      if (!isMountedRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      stream.getTracks().forEach((track) => track.stop());
      void refreshDevices();
    } catch (permissionError) {
      if (!isMountedRef.current) {
        return;
      }
      setError(mapVideoRecorderErrorMessage(permissionError));
      if (isDeviceSelectionError(permissionError)) {
        void refreshDevices();
      }
    } finally {
      permissionRequestInFlightRef.current = false;
      if (isMountedRef.current) {
        setIsRequestingPermissions(false);
      }
    }
  }, [refreshDevices, settings]);

  useEffect(() => {
    refreshDevices();
  }, [refreshDevices]);

  useEffect(() => {
    saveVideoRecorderSettings(settings);
  }, [settings]);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      cleanupStreams();
    };
  }, [cleanupStreams]);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.hidden && recorderRef.current?.state === "recording") {
        try {
          recorderRef.current.pause();
          setStatus("paused");
          pausedAtRef.current = Date.now();
          clearElapsedTimer();
        } catch (pauseError) {
          console.error(pauseError);
          setError(mapVideoRecorderErrorMessage(pauseError));
          setStatus("error");
          cleanupStreams();
        }
      }
    };

    document.addEventListener(EVENT.VISIBILITY_CHANGE, onVisibilityChange);
    return () =>
      document.removeEventListener(EVENT.VISIBILITY_CHANGE, onVisibilityChange);
  }, [cleanupStreams, clearElapsedTimer]);

  const setSettings = useCallback(
    (
      next:
        | Partial<VideoRecorderSettings>
        | ((prev: VideoRecorderSettings) => VideoRecorderSettings),
    ) => {
      setSettingsState((prev) => {
        const nextValue =
          typeof next === "function"
            ? next(prev)
            : {
                ...prev,
                ...next,
              };

        const mimeType = normalizeRecorderMimeType(
          nextValue.mimeType,
          capabilities.supportedMimeTypes,
        );

        return {
          ...nextValue,
          mimeType,
        };
      });
    },
    [capabilities.supportedMimeTypes],
  );

  const updateCameraLayout = useCallback(
    (
      next:
        | Partial<VideoRecorderOverlayLayout>
        | ((prev: VideoRecorderOverlayLayout) => VideoRecorderOverlayLayout),
    ) => {
      setSettingsState((prev) => {
        const merged =
          typeof next === "function"
            ? next(prev.camera)
            : { ...prev.camera, ...next };
        return {
          ...prev,
          camera: clampOverlayLayout(merged),
        };
      });
    },
    [],
  );

  const startElapsedTicker = useCallback(() => {
    clearElapsedTimer();
    elapsedTimerRef.current = window.setInterval(() => {
      if (!startedAtRef.current) {
        return;
      }
      const pausedDuration = pausedAccumulatedRef.current;
      const now = Date.now();
      setElapsedMs(Math.max(0, now - startedAtRef.current - pausedDuration));
    }, 100);
  }, [clearElapsedTimer]);

  const startRecording = useCallback(async () => {
    if (startRecordingInFlightRef.current) {
      return;
    }

    if (!capabilities.isSupported) {
      setError(t("videoRecorder.errors.notSupported"));
      setStatus("error");
      return;
    }

    if (
      status === "recording" ||
      status === "paused" ||
      status === "preparing" ||
      status === "stopping"
    ) {
      return;
    }

    const requestId = startRecordingRequestIdRef.current + 1;
    startRecordingRequestIdRef.current = requestId;
    const assertStartRequestActive = () => {
      if (
        !isMountedRef.current ||
        requestId !== startRecordingRequestIdRef.current
      ) {
        throw new StartRecordingCancelledError();
      }
    };

    startRecordingInFlightRef.current = true;
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error(t("videoRecorder.errors.notSupported"));
      }

      setError(null);
      setResult(null);
      setStatus("preparing");
      chunksRef.current = [];
      startedAtRef.current = Date.now();
      pausedAtRef.current = null;
      pausedAccumulatedRef.current = 0;
      setElapsedMs(0);

      const { width, height } = getVideoDimensions(
        settings.aspectRatio,
        settings.resolution,
      );

      const { staticCanvas, interactiveCanvas } = getExcalidrawCanvases();

      const compositionCanvas = document.createElement("canvas");
      compositionCanvas.width = width;
      compositionCanvas.height = height;
      compositionCanvasRef.current = compositionCanvas;

      const compositionContext = compositionCanvas.getContext("2d");
      if (!compositionContext) {
        throw new Error(t("videoRecorder.errors.contextUnavailable"));
      }

      if (settings.cameraEnabled) {
        const requestedVideoDeviceId = settings.selectedVideoDeviceId;
        const cameraStream = await getUserMediaWithDeviceFallback(
          {
            video: requestedVideoDeviceId
              ? { deviceId: { exact: requestedVideoDeviceId } }
              : true,
            audio: false,
          },
          requestedVideoDeviceId ? { video: true, audio: false } : undefined,
          () => {
            if (!isMountedRef.current) {
              return;
            }
            setSettingsState((prev) => {
              const selectedVideoDeviceId =
                prev.cameraEnabled &&
                prev.selectedVideoDeviceId === requestedVideoDeviceId
                  ? null
                  : prev.selectedVideoDeviceId;

              if (selectedVideoDeviceId === prev.selectedVideoDeviceId) {
                return prev;
              }

              return {
                ...prev,
                selectedVideoDeviceId,
              };
            });
          },
        );
        cameraStreamRef.current = cameraStream;
        assertStartRequestActive();

        const cameraVideo = document.createElement("video");
        cameraVideo.srcObject = cameraStream;
        cameraVideo.playsInline = true;
        cameraVideo.muted = true;
        cameraVideo.autoplay = true;
        await cameraVideo.play();
        assertStartRequestActive();
        cameraVideoRef.current = cameraVideo;
      }

      if (settings.microphoneEnabled) {
        const requestedAudioDeviceId = settings.selectedAudioDeviceId;
        const micStream = await getUserMediaWithDeviceFallback(
          {
            audio: requestedAudioDeviceId
              ? { deviceId: { exact: requestedAudioDeviceId } }
              : true,
            video: false,
          },
          requestedAudioDeviceId ? { audio: true, video: false } : undefined,
          () => {
            if (!isMountedRef.current) {
              return;
            }
            setSettingsState((prev) => {
              const selectedAudioDeviceId =
                prev.microphoneEnabled &&
                prev.selectedAudioDeviceId === requestedAudioDeviceId
                  ? null
                  : prev.selectedAudioDeviceId;

              if (selectedAudioDeviceId === prev.selectedAudioDeviceId) {
                return prev;
              }

              return {
                ...prev,
                selectedAudioDeviceId,
              };
            });
          },
        );
        microphoneStreamRef.current = micStream;
        assertStartRequestActive();
      }

      const renderFrame = () => {
        compositionContext.fillStyle = "#000000";
        compositionContext.fillRect(0, 0, width, height);

        drawCanvasContain(compositionContext, staticCanvas, width, height);
        drawCanvasContain(compositionContext, interactiveCanvas, width, height);

        if (cameraVideoRef.current && settings.cameraEnabled) {
          drawCameraOverlay({
            context: compositionContext,
            cameraVideo: cameraVideoRef.current,
            targetWidth: width,
            targetHeight: height,
            layout: settings.camera,
          });
        }

        renderFrameRef.current = requestAnimationFrame(renderFrame);
      };

      renderFrameRef.current = requestAnimationFrame(renderFrame);

      const canvasStream = compositionCanvas.captureStream(settings.fps);
      const composedStream = new MediaStream();
      canvasStream
        .getVideoTracks()
        .forEach((track) => composedStream.addTrack(track));
      microphoneStreamRef.current
        ?.getAudioTracks()
        .forEach((track) => composedStream.addTrack(track));
      recordingStreamRef.current = composedStream;

      const mimeType =
        capabilities.supportedMimeTypes.find(
          (item) => item === settings.mimeType,
        ) || capabilities.supportedMimeTypes[0];

      const recorder = new MediaRecorder(composedStream, { mimeType });
      recorderRef.current = recorder;
      let didRecorderFail = false;

      recorder.ondataavailable = (event) => {
        if (event.data?.size) {
          chunksRef.current.push(event.data);
        }
      };

      recorder.onerror = (event) => {
        didRecorderFail = true;
        setError(
          event.error?.message || t("videoRecorder.errors.recordingFailed"),
        );
        setStatus("error");
        cleanupStreams();
      };

      recorder.onstop = () => {
        if (didRecorderFail) {
          cleanupStreams();
          return;
        }

        const finalizedMimeType = mimeType || settings.mimeType;
        const blob = new Blob(chunksRef.current, {
          type: finalizedMimeType,
        });
        const durationMs =
          startedAtRef.current == null
            ? elapsedMs
            : Math.max(
                elapsedMs,
                Date.now() -
                  startedAtRef.current -
                  pausedAccumulatedRef.current -
                  (pausedAtRef.current ? Date.now() - pausedAtRef.current : 0),
              );

        setElapsedMs(durationMs);
        setResult({
          blob,
          mimeType: finalizedMimeType,
          durationMs,
          createdAt: Date.now(),
        });
        setStatus("completed");
        cleanupStreams();
      };

      recorder.start(MEDIA_RECORDER_TIMESLICE_MS);
      setStatus("recording");
      setDialogOpen(false);
      startElapsedTicker();
      void refreshDevices();
    } catch (startError) {
      if (
        startError instanceof StartRecordingCancelledError ||
        !isMountedRef.current ||
        requestId !== startRecordingRequestIdRef.current
      ) {
        cleanupStreams();
        return;
      }
      console.error(startError);
      setError(mapVideoRecorderErrorMessage(startError));
      setStatus("error");
      cleanupStreams();
      if (isDeviceSelectionError(startError)) {
        void refreshDevices();
      }
    } finally {
      startRecordingInFlightRef.current = false;
    }
  }, [
    capabilities,
    cleanupStreams,
    elapsedMs,
    refreshDevices,
    settings,
    startElapsedTicker,
    status,
  ]);

  const pauseRecording = useCallback(() => {
    if (recorderRef.current?.state !== "recording") {
      return;
    }
    try {
      recorderRef.current.pause();
      pausedAtRef.current = Date.now();
      setStatus("paused");
      clearElapsedTimer();
    } catch (pauseError) {
      console.error(pauseError);
      setError(mapVideoRecorderErrorMessage(pauseError));
      setStatus("error");
      cleanupStreams();
    }
  }, [cleanupStreams, clearElapsedTimer]);

  const resumeRecording = useCallback(() => {
    if (recorderRef.current?.state !== "paused") {
      return;
    }
    try {
      recorderRef.current.resume();
      if (pausedAtRef.current) {
        pausedAccumulatedRef.current += Date.now() - pausedAtRef.current;
        pausedAtRef.current = null;
      }
      setStatus("recording");
      startElapsedTicker();
    } catch (resumeError) {
      console.error(resumeError);
      setError(mapVideoRecorderErrorMessage(resumeError));
      setStatus("error");
      cleanupStreams();
    }
  }, [cleanupStreams, startElapsedTicker]);

  const stopRecording = useCallback(async () => {
    if (stopRecordingInFlightRef.current) {
      return;
    }

    if (status === "stopping") {
      return;
    }

    if (
      !recorderRef.current ||
      (recorderRef.current.state !== "recording" &&
        recorderRef.current.state !== "paused")
    ) {
      return;
    }

    stopRecordingInFlightRef.current = true;
    setStatus("stopping");
    clearElapsedTimer();

    await new Promise<void>((resolve) => {
      const recorder = recorderRef.current;
      if (!recorder) {
        stopRecordingInFlightRef.current = false;
        resolve();
        return;
      }

      let settled = false;
      const finalize = () => {
        if (settled) {
          return;
        }
        settled = true;
        if (stopRecordingTimeoutRef.current != null) {
          window.clearTimeout(stopRecordingTimeoutRef.current);
          stopRecordingTimeoutRef.current = null;
        }
        stopRecordingInFlightRef.current = false;
        stopRecordingFinalizeRef.current = null;
        resolve();
      };
      stopRecordingFinalizeRef.current = finalize;

      const handleStop = () => {
        recorder.removeEventListener("stop", handleStop);
        finalize();
      };
      recorder.addEventListener("stop", handleStop);
      stopRecordingTimeoutRef.current = window.setTimeout(() => {
        recorder.removeEventListener("stop", handleStop);
        setError(t("videoRecorder.errors.recordingFailed"));
        setStatus("error");
        cleanupStreams();
        finalize();
      }, STOP_RECORDING_TIMEOUT_MS);

      try {
        recorder.stop();
      } catch (stopError) {
        recorder.removeEventListener("stop", handleStop);
        setError(mapVideoRecorderErrorMessage(stopError));
        setStatus("error");
        cleanupStreams();
        finalize();
      }
    });
  }, [cleanupStreams, clearElapsedTimer, status]);

  const resetResult = useCallback(() => {
    setResult(null);
    setError(null);
    setElapsedMs(0);
    setStatus("idle");
  }, []);

  const downloadRecording = useCallback(
    (name: string) => {
      if (!result) {
        return;
      }
      const extension = getFileExtensionFromMimeType(result.mimeType);
      const sanitizedName = sanitizeRecordingFileName(name);
      const url = URL.createObjectURL(result.blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${sanitizedName}.${extension}`;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);
    },
    [result],
  );

  const isRecordingActive = status === "recording" || status === "paused";

  return {
    capabilities,
    settings,
    status,
    error,
    isDialogOpen,
    elapsedMs,
    result,
    devices,
    isRecordingActive,
    isRequestingPermissions,
    setDialogOpen,
    setSettings,
    updateCameraLayout,
    refreshDevices,
    requestMediaPermissions,
    startRecording,
    pauseRecording,
    resumeRecording,
    stopRecording,
    resetResult,
    downloadRecording,
  };
};
