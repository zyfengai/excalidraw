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
  getVideoDimensions,
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

const getErrorMessage = (error: unknown) => {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
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
    const candidateMimeType = loaded.mimeType || defaults.mimeType || "";
    const mimeType = capabilities.supportedMimeTypes.includes(candidateMimeType)
      ? candidateMimeType
      : capabilities.supportedMimeTypes[0] || "";

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

  const clearElapsedTimer = useCallback(() => {
    if (elapsedTimerRef.current != null) {
      window.clearInterval(elapsedTimerRef.current);
      elapsedTimerRef.current = null;
    }
  }, []);

  const cleanupStreams = useCallback(() => {
    if (renderFrameRef.current != null) {
      cancelAnimationFrame(renderFrameRef.current);
      renderFrameRef.current = null;
    }

    recorderRef.current = null;

    recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
    recordingStreamRef.current = null;

    cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
    cameraStreamRef.current = null;

    microphoneStreamRef.current?.getTracks().forEach((track) => track.stop());
    microphoneStreamRef.current = null;

    if (cameraVideoRef.current) {
      cameraVideoRef.current.pause();
      cameraVideoRef.current.srcObject = null;
      cameraVideoRef.current = null;
    }

    compositionCanvasRef.current = null;
    clearElapsedTimer();
  }, [clearElapsedTimer]);

  const refreshDevices = useCallback(async () => {
    try {
      const mediaDevices = await collectMediaDevices();
      setDevices(mediaDevices);
    } catch (deviceError) {
      console.error(deviceError);
    }
  }, []);

  useEffect(() => {
    refreshDevices();
  }, [refreshDevices]);

  useEffect(() => {
    saveVideoRecorderSettings(settings);
  }, [settings]);

  useEffect(() => {
    return () => {
      cleanupStreams();
    };
  }, [cleanupStreams]);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.hidden && recorderRef.current?.state === "recording") {
        recorderRef.current.pause();
        setStatus("paused");
        pausedAtRef.current = Date.now();
      }
    };

    document.addEventListener(EVENT.VISIBILITY_CHANGE, onVisibilityChange);
    return () =>
      document.removeEventListener(EVENT.VISIBILITY_CHANGE, onVisibilityChange);
  }, []);

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

        const mimeType = capabilities.supportedMimeTypes.includes(
          nextValue.mimeType,
        )
          ? nextValue.mimeType
          : capabilities.supportedMimeTypes[0] || "";

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
    if (!capabilities.isSupported) {
      setError(t("videoRecorder.errors.notSupported"));
      setStatus("error");
      return;
    }

    if (status === "recording" || status === "preparing") {
      return;
    }

    try {
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
        const cameraStream = await navigator.mediaDevices.getUserMedia({
          video: settings.selectedVideoDeviceId
            ? { deviceId: { exact: settings.selectedVideoDeviceId } }
            : true,
          audio: false,
        });
        cameraStreamRef.current = cameraStream;

        const cameraVideo = document.createElement("video");
        cameraVideo.srcObject = cameraStream;
        cameraVideo.playsInline = true;
        cameraVideo.muted = true;
        cameraVideo.autoplay = true;
        await cameraVideo.play();
        cameraVideoRef.current = cameraVideo;
      }

      if (settings.microphoneEnabled) {
        const micStream = await navigator.mediaDevices.getUserMedia({
          audio: settings.selectedAudioDeviceId
            ? { deviceId: { exact: settings.selectedAudioDeviceId } }
            : true,
          video: false,
        });
        microphoneStreamRef.current = micStream;
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

      recorder.ondataavailable = (event) => {
        if (event.data?.size) {
          chunksRef.current.push(event.data);
        }
      };

      recorder.onerror = (event) => {
        setError(
          event.error?.message || t("videoRecorder.errors.recordingFailed"),
        );
        setStatus("error");
      };

      recorder.onstop = () => {
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
      await refreshDevices();
    } catch (startError) {
      console.error(startError);
      setError(getErrorMessage(startError));
      setStatus("error");
      cleanupStreams();
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
    recorderRef.current.pause();
    pausedAtRef.current = Date.now();
    setStatus("paused");
    clearElapsedTimer();
  }, [clearElapsedTimer]);

  const resumeRecording = useCallback(() => {
    if (recorderRef.current?.state !== "paused") {
      return;
    }
    recorderRef.current.resume();
    if (pausedAtRef.current) {
      pausedAccumulatedRef.current += Date.now() - pausedAtRef.current;
      pausedAtRef.current = null;
    }
    setStatus("recording");
    startElapsedTicker();
  }, [startElapsedTicker]);

  const stopRecording = useCallback(async () => {
    if (
      !recorderRef.current ||
      (recorderRef.current.state !== "recording" &&
        recorderRef.current.state !== "paused")
    ) {
      return;
    }

    setStatus("stopping");
    clearElapsedTimer();

    await new Promise<void>((resolve) => {
      const recorder = recorderRef.current;
      if (!recorder) {
        resolve();
        return;
      }
      const handleStop = () => {
        recorder.removeEventListener("stop", handleStop);
        resolve();
      };
      recorder.addEventListener("stop", handleStop);
      recorder.stop();
    });
  }, [clearElapsedTimer]);

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
      const url = URL.createObjectURL(result.blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${name || "excalidraw-recording"}.${extension}`;
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
    setDialogOpen,
    setSettings,
    updateCameraLayout,
    refreshDevices,
    startRecording,
    pauseRecording,
    resumeRecording,
    stopRecording,
    resetResult,
    downloadRecording,
  };
};
