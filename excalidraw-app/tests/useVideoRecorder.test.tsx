import { act, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EVENT } from "@excalidraw/common";

import { STORAGE_KEYS } from "../app_constants";
import { getDefaultVideoRecorderSettings } from "../components/video-recorder/videoRecorder.config";
import {
  mapVideoRecorderErrorMessage,
  useVideoRecorder,
} from "../components/video-recorder/useVideoRecorder";

import type { VideoRecorderSettings } from "../components/video-recorder/videoRecorder.types";

const OriginalMediaRecorder = globalThis.MediaRecorder;
const OriginalMediaStream = globalThis.MediaStream;
const OriginalMediaDevices = navigator.mediaDevices;
const OriginalCanvasCaptureStream = HTMLCanvasElement.prototype.captureStream;
const OriginalDocumentHiddenDescriptor = Object.getOwnPropertyDescriptor(
  document,
  "hidden",
);

const setMediaRecorderSupport = (supportedMimeTypes: string[]) => {
  class MockMediaRecorder {}
  (MockMediaRecorder as any).isTypeSupported = (mimeType: string) =>
    supportedMimeTypes.includes(mimeType);

  globalThis.MediaRecorder = MockMediaRecorder as any;
};

const setMediaDevicesMock = (value: Partial<MediaDevices>) => {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value,
  });
};

const createMockMediaDevice = (
  kind: MediaDeviceKind,
  deviceId: string,
  label: string,
) =>
  ({
    deviceId,
    groupId: "",
    kind,
    label,
    toJSON: () => ({}),
  } as MediaDeviceInfo);

const createMockCanvasContext = () =>
  ({
    fillStyle: "",
    fillRect: vi.fn(),
    drawImage: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    clip: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    quadraticCurveTo: vi.fn(),
    closePath: vi.fn(),
  } as unknown as CanvasRenderingContext2D);

const createExcalidrawCanvases = () => {
  const root = document.createElement("div");
  root.className = "excalidraw";

  const staticCanvas = document.createElement("canvas");
  staticCanvas.className = "static";
  staticCanvas.width = 1200;
  staticCanvas.height = 800;

  const interactiveCanvas = document.createElement("canvas");
  interactiveCanvas.className = "interactive";
  interactiveCanvas.width = 1200;
  interactiveCanvas.height = 800;

  root.appendChild(staticCanvas);
  root.appendChild(interactiveCanvas);
  document.body.appendChild(root);

  return {
    root,
    cleanup: () => root.remove(),
  };
};

const setupRecordingFlowMocks = (opts?: {
  deferStop?: boolean;
  stopThrows?: boolean;
  pauseThrows?: boolean;
  resumeThrows?: boolean;
  trackStopThrows?: boolean;
  supportedMimeTypes?: string[];
  unsupportedConstructorMimeTypes?: string[];
  typeErrorConstructorMimeTypes?: string[];
  nonRecoverableTypeErrorConstructorMimeTypes?: string[];
  namedNotSupportedConstructorMimeTypes?: string[];
  messageNotSupportedConstructorMimeTypes?: string[];
  messageNotSupportedConstructorErrorMessage?: string;
  defaultConstructorMimeType?: string;
  omitIsTypeSupported?: boolean;
}) => {
  const cleanupSpy = vi.fn();
  const pauseSpy = vi.fn();
  const resumeSpy = vi.fn();
  const videoTrackStop = vi.fn(() => {
    if (opts?.trackStopThrows) {
      throw new Error("track stop failed");
    }
  });
  let latestRecorder: any = null;
  let stopCallCount = 0;
  let flushStop: (() => void) | null = null;
  const captureStreamSpy = vi.fn(() => ({
    getVideoTracks: () =>
      [
        {
          kind: "video",
          stop: videoTrackStop,
        },
      ] as unknown as MediaStreamTrack[],
  }));

  setMediaDevicesMock({
    enumerateDevices: vi.fn(async () => []),
    getUserMedia: vi.fn(),
  });
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() =>
    createMockCanvasContext(),
  );
  Object.defineProperty(HTMLCanvasElement.prototype, "captureStream", {
    configurable: true,
    value: captureStreamSpy,
  });

  class MockMediaStream {
    private tracks: MediaStreamTrack[] = [];
    addTrack(track: MediaStreamTrack) {
      this.tracks.push(track);
    }
    getTracks() {
      return this.tracks;
    }
    getAudioTracks() {
      return this.tracks.filter((track) => track.kind === "audio");
    }
  }
  globalThis.MediaStream = MockMediaStream as any;

  class FunctionalMediaRecorder {
    static isTypeSupported = (mimeType: string) =>
      opts?.supportedMimeTypes
        ? opts.supportedMimeTypes.includes(mimeType)
        : mimeType.includes("webm");
    state: RecordingState = "inactive";
    mimeType: string;
    ondataavailable: ((event: BlobEvent) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: ((event: any) => void) | null = null;
    private stopListeners = new Set<() => void>();

    constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
      const requestedMimeType =
        options?.mimeType || opts?.defaultConstructorMimeType || "video/webm";
      if (
        options?.mimeType &&
        opts?.namedNotSupportedConstructorMimeTypes?.includes(requestedMimeType)
      ) {
        const notSupportedError = new Error("mime type not supported");
        notSupportedError.name = "NotSupportedError";
        throw notSupportedError;
      }
      if (
        options?.mimeType &&
        opts?.messageNotSupportedConstructorMimeTypes?.includes(
          requestedMimeType,
        )
      ) {
        throw new Error(
          opts?.messageNotSupportedConstructorErrorMessage ||
            "The MIME type provided is not supported by this user agent.",
        );
      }
      if (
        options?.mimeType &&
        opts?.nonRecoverableTypeErrorConstructorMimeTypes?.includes(
          requestedMimeType,
        )
      ) {
        throw new TypeError("Cannot convert undefined or null to object");
      }
      if (
        options?.mimeType &&
        opts?.typeErrorConstructorMimeTypes?.includes(requestedMimeType)
      ) {
        throw new TypeError("invalid mime type option");
      }
      if (
        options?.mimeType &&
        opts?.unsupportedConstructorMimeTypes?.includes(requestedMimeType)
      ) {
        throw new DOMException("mime type not supported", "NotSupportedError");
      }
      this.mimeType = requestedMimeType;
      latestRecorder = this;
    }
    start() {
      this.state = "recording";
      this.ondataavailable?.({
        data: new Blob(["chunk"], { type: this.mimeType }),
      } as BlobEvent);
    }
    pause() {
      if (opts?.pauseThrows) {
        throw new Error("pause failed");
      }
      this.state = "paused";
      pauseSpy();
    }
    resume() {
      if (opts?.resumeThrows) {
        throw new Error("resume failed");
      }
      this.state = "recording";
      resumeSpy();
    }
    stop() {
      stopCallCount += 1;
      if (opts?.stopThrows) {
        throw new Error("stop failed");
      }
      const finalizeStop = () => {
        this.state = "inactive";
        this.stopListeners.forEach((listener) => listener());
        this.onstop?.();
        cleanupSpy();
      };

      if (opts?.deferStop) {
        flushStop = finalizeStop;
        return;
      }

      finalizeStop();
    }
    addEventListener(event: "stop", listener: () => void) {
      if (event === "stop") {
        this.stopListeners.add(listener);
      }
    }
    removeEventListener(event: "stop", listener: () => void) {
      if (event === "stop") {
        this.stopListeners.delete(listener);
      }
    }
  }
  if (opts?.omitIsTypeSupported) {
    delete (FunctionalMediaRecorder as any).isTypeSupported;
  }
  globalThis.MediaRecorder = FunctionalMediaRecorder as any;

  const { cleanup } = createExcalidrawCanvases();
  const createObjectURLSpy = vi
    .spyOn(URL, "createObjectURL")
    .mockReturnValue("blob:mock-url");
  const revokeObjectURLSpy = vi
    .spyOn(URL, "revokeObjectURL")
    .mockImplementation(() => {});
  const downloadedFileNames: string[] = [];
  const clickSpy = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(function (this: HTMLAnchorElement) {
      downloadedFileNames.push(this.download);
    });

  return {
    cleanupSpy,
    pauseSpy,
    resumeSpy,
    videoTrackStop,
    captureStreamSpy,
    getStopCallCount: () => stopCallCount,
    flushStop: () => flushStop?.(),
    emitRecorderError: (error?: unknown) => {
      const normalizedError =
        typeof error === "string" ? new Error(error) : error;
      latestRecorder?.onerror?.({
        error: normalizedError,
      });
    },
    emitRecorderErrorEvent: (event?: unknown) => {
      latestRecorder?.onerror?.(event);
    },
    emitRecorderStop: () => {
      latestRecorder?.onstop?.();
    },
    getRecorderHandlers: () => ({
      ondataavailable: latestRecorder?.ondataavailable,
      onerror: latestRecorder?.onerror,
      onstop: latestRecorder?.onstop,
    }),
    createObjectURLSpy,
    revokeObjectURLSpy,
    clickSpy,
    getDownloadedFileNames: () => downloadedFileNames,
    cleanupCanvases: cleanup,
  };
};

const renderUseVideoRecorder = () => {
  let latest: ReturnType<typeof useVideoRecorder> | null = null;

  const Probe = () => {
    latest = useVideoRecorder();
    return null;
  };

  const rendered = render(<Probe />);

  return {
    get latest() {
      if (!latest) {
        throw new Error("useVideoRecorder is not initialized");
      }
      return latest;
    },
    unmount: () => rendered.unmount(),
  };
};

afterEach(() => {
  if (OriginalMediaRecorder) {
    globalThis.MediaRecorder = OriginalMediaRecorder;
  } else {
    delete (globalThis as any).MediaRecorder;
  }

  if (OriginalMediaStream) {
    globalThis.MediaStream = OriginalMediaStream;
  } else {
    delete (globalThis as any).MediaStream;
  }

  if (OriginalMediaDevices) {
    setMediaDevicesMock(OriginalMediaDevices);
  } else {
    delete (navigator as any).mediaDevices;
  }

  if (OriginalCanvasCaptureStream) {
    HTMLCanvasElement.prototype.captureStream = OriginalCanvasCaptureStream;
  } else {
    delete (HTMLCanvasElement.prototype as any).captureStream;
  }

  if (OriginalDocumentHiddenDescriptor) {
    Object.defineProperty(document, "hidden", OriginalDocumentHiddenDescriptor);
  }

  localStorage.removeItem(STORAGE_KEYS.LOCAL_STORAGE_VIDEO_RECORDER);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useVideoRecorder", () => {
  it("normalizes mimeType from persisted settings and setSettings", async () => {
    setMediaRecorderSupport(["video/webm"]);
    setMediaDevicesMock({
      enumerateDevices: vi.fn(async () => []),
    });

    const defaults = getDefaultVideoRecorderSettings();
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_VIDEO_RECORDER,
      JSON.stringify({
        version: 1,
        settings: {
          ...defaults,
          mimeType: "video/mp4",
        },
      }),
    );

    const recorder = renderUseVideoRecorder();

    await waitFor(() => {
      expect(recorder.latest.settings.mimeType).toBe("video/webm");
    });

    act(() => {
      recorder.latest.setSettings({ mimeType: "video/unknown" });
    });

    await waitFor(() => {
      expect(recorder.latest.settings.mimeType).toBe("video/webm");
    });
  });

  it("keeps supported mimeType when candidate casing differs", async () => {
    setMediaRecorderSupport(["video/webm", "video/mp4"]);
    setMediaDevicesMock({
      enumerateDevices: vi.fn(async () => []),
    });

    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({ mimeType: " VIDEO/MP4 " });
    });

    await waitFor(() => {
      expect(recorder.latest.settings.mimeType).toBe("video/mp4");
    });
  });

  it("normalizes codec mimeType spacing to supported canonical value", async () => {
    setMediaRecorderSupport(["video/webm;codecs=vp9,opus", "video/webm"]);
    setMediaDevicesMock({
      enumerateDevices: vi.fn(async () => []),
    });

    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        mimeType: "video / webm; codecs = opus, vp9",
      });
    });

    await waitFor(() => {
      expect(recorder.latest.settings.mimeType).toBe(
        "video/webm;codecs=vp9,opus",
      );
    });
  });

  it("skips settings state updates when normalized values are unchanged", async () => {
    setMediaRecorderSupport(["video/webm"]);
    setMediaDevicesMock({
      enumerateDevices: vi.fn(async () => []),
    });

    const recorder = renderUseVideoRecorder();
    await waitFor(() => {
      expect(recorder.latest.devices).toEqual({
        videoInputs: [],
        audioInputs: [],
      });
    });

    const previousSettings = recorder.latest.settings;

    act(() => {
      recorder.latest.setSettings((settings) => ({
        ...settings,
      }));
    });

    expect(recorder.latest.settings).toBe(previousSettings);
  });

  it("normalizes blank selected device ids to null in setSettings", async () => {
    setMediaRecorderSupport(["video/webm"]);
    setMediaDevicesMock({
      enumerateDevices: vi.fn(async () => []),
    });

    const recorder = renderUseVideoRecorder();
    await waitFor(() => {
      expect(recorder.latest.devices).toEqual({
        videoInputs: [],
        audioInputs: [],
      });
    });

    const previousSettings = recorder.latest.settings;

    act(() => {
      recorder.latest.setSettings({
        selectedVideoDeviceId: "   ",
        selectedAudioDeviceId: " ",
      });
    });

    expect(recorder.latest.settings).toBe(previousSettings);
    expect(recorder.latest.settings.selectedVideoDeviceId).toBeNull();
    expect(recorder.latest.settings.selectedAudioDeviceId).toBeNull();
  });

  it("trims selected device ids in setSettings", async () => {
    setMediaRecorderSupport(["video/webm"]);
    setMediaDevicesMock({
      enumerateDevices: vi.fn(async () => []),
    });

    const recorder = renderUseVideoRecorder();
    await waitFor(() => {
      expect(recorder.latest.devices).toEqual({
        videoInputs: [],
        audioInputs: [],
      });
    });

    act(() => {
      recorder.latest.setSettings({
        selectedVideoDeviceId: " camera-1 ",
        selectedAudioDeviceId: " mic-1 ",
      });
    });

    expect(recorder.latest.settings.selectedVideoDeviceId).toBe("camera-1");
    expect(recorder.latest.settings.selectedAudioDeviceId).toBe("mic-1");
  });

  it("trims video profile values in setSettings", async () => {
    setMediaRecorderSupport(["video/webm"]);
    setMediaDevicesMock({
      enumerateDevices: vi.fn(async () => []),
    });

    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        aspectRatio:
          " 4 : 3 " as unknown as VideoRecorderSettings["aspectRatio"],
        resolution: " 720 p " as unknown as VideoRecorderSettings["resolution"],
      });
    });

    await waitFor(() => {
      expect(recorder.latest.settings.aspectRatio).toBe("4:3");
      expect(recorder.latest.settings.resolution).toBe("720p");
    });
  });

  it("coerces video profile, camera, fps and teleprompter ranges when setSettings receives out-of-range values", async () => {
    setMediaRecorderSupport(["video/webm"]);
    setMediaDevicesMock({
      enumerateDevices: vi.fn(async () => []),
    });

    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings((settings) => ({
        ...settings,
        camera: {
          x: -0.5,
          y: 2,
          width: 2,
          height: 0.01,
          shape: "circle",
        },
        teleprompter: {
          ...settings.teleprompter,
          opacity: 9,
          speed: 0,
        },
        fps: 500,
        aspectRatio:
          "unsupported-ratio" as unknown as VideoRecorderSettings["aspectRatio"],
        resolution:
          "bad-resolution" as unknown as VideoRecorderSettings["resolution"],
      }));
    });

    await waitFor(() => {
      expect(recorder.latest.settings.camera.shape).toBe("circle");
      expect(recorder.latest.settings.camera.x).toBe(0);
      expect(recorder.latest.settings.camera.y).toBeCloseTo(0.2);
      expect(recorder.latest.settings.camera.width).toBe(0.8);
      expect(recorder.latest.settings.camera.height).toBe(0.8);
      expect(recorder.latest.settings.aspectRatio).toBe("16:9");
      expect(recorder.latest.settings.resolution).toBe("1080p");
      expect(recorder.latest.settings.fps).toBe(60);
      expect(recorder.latest.settings.teleprompter.opacity).toBe(1);
      expect(recorder.latest.settings.teleprompter.speed).toBe(5);
    });
  });

  it("coerces malformed camera and teleprompter values in setSettings", async () => {
    setMediaRecorderSupport(["video/webm"]);
    setMediaDevicesMock({
      enumerateDevices: vi.fn(async () => []),
    });

    const recorder = renderUseVideoRecorder();
    const previousSettings = recorder.latest.settings;

    act(() => {
      recorder.latest.setSettings((settings) => ({
        ...settings,
        camera: {
          x: "left",
          y: settings.camera.y,
          width: settings.camera.width,
          height: Number.POSITIVE_INFINITY,
          shape: "triangle",
        } as unknown as VideoRecorderSettings["camera"],
        teleprompter: {
          ...settings.teleprompter,
          enabled: "yes",
          text: 123,
          opacity: Number.NaN,
          speed: Number.POSITIVE_INFINITY,
        } as unknown as VideoRecorderSettings["teleprompter"],
      }));
    });

    await waitFor(() => {
      expect(recorder.latest.settings.camera).toEqual({
        ...previousSettings.camera,
      });
      expect(recorder.latest.settings.teleprompter).toEqual({
        ...previousSettings.teleprompter,
      });
    });
  });

  it("normalizes fps to supported preset values in setSettings", async () => {
    setMediaRecorderSupport(["video/webm"]);
    setMediaDevicesMock({
      enumerateDevices: vi.fn(async () => []),
    });

    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({ fps: 5 });
    });
    await waitFor(() => {
      expect(recorder.latest.settings.fps).toBe(24);
    });

    act(() => {
      recorder.latest.setSettings({ fps: 52 });
    });
    await waitFor(() => {
      expect(recorder.latest.settings.fps).toBe(60);
    });
  });

  it("preserves previous settings when malformed top-level payload is provided", async () => {
    setMediaRecorderSupport(["video/webm"]);
    setMediaDevicesMock({
      enumerateDevices: vi.fn(async () => []),
    });

    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings((settings) => ({
        ...settings,
        cameraEnabled: true,
        microphoneEnabled: false,
        selectedVideoDeviceId: "camera-1",
        selectedAudioDeviceId: "mic-1",
        camera: {
          x: 0.2,
          y: 0.15,
          width: 0.34,
          height: 0.34,
          shape: "circle",
        },
        teleprompter: {
          ...settings.teleprompter,
          enabled: true,
          text: "hello",
          opacity: 0.6,
          speed: 45,
        },
      }));
    });

    await waitFor(() => {
      expect(recorder.latest.settings.selectedVideoDeviceId).toBe("camera-1");
      expect(recorder.latest.settings.selectedAudioDeviceId).toBe("mic-1");
    });

    const previousSettings = recorder.latest.settings;
    const malformedSettings = {
      cameraEnabled: "enabled",
      microphoneEnabled: 1,
      selectedVideoDeviceId: 123,
      selectedAudioDeviceId: {},
      aspectRatio: 42,
      resolution: false,
      fps: Number.NaN,
      mimeType: 999,
      camera: undefined,
      teleprompter: undefined,
    } as unknown as VideoRecorderSettings;

    act(() => {
      recorder.latest.setSettings(() => malformedSettings);
    });

    expect(recorder.latest.settings).toBe(previousSettings);
    expect(recorder.latest.settings).toEqual(previousSettings);
  });

  it("ignores non-object setSettings updater results", async () => {
    setMediaRecorderSupport(["video/webm"]);
    setMediaDevicesMock({
      enumerateDevices: vi.fn(async () => []),
    });

    const recorder = renderUseVideoRecorder();
    const previousSettings = recorder.latest.settings;

    act(() => {
      recorder.latest.setSettings(
        () => null as unknown as VideoRecorderSettings,
      );
    });

    expect(recorder.latest.settings).toBe(previousSettings);
    expect(recorder.latest.settings).toEqual(previousSettings);
  });

  it("clamps camera layout updates to valid range", async () => {
    setMediaRecorderSupport(["video/webm"]);
    setMediaDevicesMock({
      enumerateDevices: vi.fn(async () => []),
    });

    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.updateCameraLayout({
        x: -0.4,
        y: 2,
        width: 2,
        height: 0.01,
      });
    });

    await waitFor(() => {
      expect(recorder.latest.settings.camera).toEqual({
        x: 0,
        y: 0.9,
        width: 0.8,
        height: 0.1,
        shape: "rounded",
      });
    });
  });

  it("keeps circle camera layout square after updates", async () => {
    setMediaRecorderSupport(["video/webm"]);
    setMediaDevicesMock({
      enumerateDevices: vi.fn(async () => []),
    });

    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.updateCameraLayout({
        shape: "circle",
        x: 0.92,
        y: 0.9,
        width: 0.2,
        height: 0.45,
      });
    });

    await waitFor(() => {
      expect(recorder.latest.settings.camera).toEqual({
        x: 0.55,
        y: 0.55,
        width: 0.45,
        height: 0.45,
        shape: "circle",
      });
    });
  });

  it("ignores malformed camera layout updates", async () => {
    setMediaRecorderSupport(["video/webm"]);
    setMediaDevicesMock({
      enumerateDevices: vi.fn(async () => []),
    });

    const recorder = renderUseVideoRecorder();
    const previousSettings = recorder.latest.settings;

    act(() => {
      recorder.latest.updateCameraLayout(
        () =>
          ({
            x: "left",
            y: undefined,
            width: Number.POSITIVE_INFINITY,
            height: Number.NaN,
            shape: "triangle",
          } as unknown as VideoRecorderSettings["camera"]),
      );
    });

    expect(recorder.latest.settings).toBe(previousSettings);
    expect(recorder.latest.settings.camera).toEqual(previousSettings.camera);
  });

  it("skips camera layout state updates when next layout is unchanged", async () => {
    setMediaRecorderSupport(["video/webm"]);
    setMediaDevicesMock({
      enumerateDevices: vi.fn(async () => []),
    });

    const recorder = renderUseVideoRecorder();
    await waitFor(() => {
      expect(recorder.latest.devices).toEqual({
        videoInputs: [],
        audioInputs: [],
      });
    });
    const previousSettings = recorder.latest.settings;
    const previousCamera = previousSettings.camera;

    act(() => {
      recorder.latest.updateCameraLayout((camera) => ({
        ...camera,
      }));
    });

    expect(recorder.latest.settings).toBe(previousSettings);
    expect(recorder.latest.settings.camera).toBe(previousCamera);
  });

  it("keeps latest device refresh results when earlier requests resolve later", async () => {
    setMediaRecorderSupport(["video/webm"]);
    let resolveInitialRefresh: ((value: MediaDeviceInfo[]) => void) | null =
      null;
    let resolveManualRefresh: ((value: MediaDeviceInfo[]) => void) | null =
      null;
    const enumerateDevices = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<MediaDeviceInfo[]>((resolve) => {
            resolveInitialRefresh = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<MediaDeviceInfo[]>((resolve) => {
            resolveManualRefresh = resolve;
          }),
      );

    setMediaDevicesMock({
      enumerateDevices,
    });

    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: true,
        microphoneEnabled: false,
        selectedVideoDeviceId: "camera-new",
      });
    });

    act(() => {
      void recorder.latest.refreshDevices();
    });

    expect(enumerateDevices).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolveManualRefresh?.([
        createMockMediaDevice("videoinput", "camera-new", "Camera New"),
      ]);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(recorder.latest.devices).toEqual({
        videoInputs: [{ deviceId: "camera-new", label: "Camera New" }],
        audioInputs: [],
      });
      expect(recorder.latest.settings.selectedVideoDeviceId).toBe("camera-new");
    });

    await act(async () => {
      resolveInitialRefresh?.([
        createMockMediaDevice("videoinput", "camera-old", "Camera Old"),
      ]);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(recorder.latest.devices).toEqual({
        videoInputs: [{ deviceId: "camera-new", label: "Camera New" }],
        audioInputs: [],
      });
      expect(recorder.latest.settings.selectedVideoDeviceId).toBe("camera-new");
    });
  });

  it("avoids replacing devices state when refresh result is unchanged after normalization", async () => {
    setMediaRecorderSupport(["video/webm"]);
    const enumerateDevices = vi
      .fn()
      .mockResolvedValueOnce([
        createMockMediaDevice("videoinput", "camera-1", "Camera One"),
        createMockMediaDevice("videoinput", "camera-2", "Camera Two"),
        createMockMediaDevice("audioinput", "mic-1", "Microphone One"),
        createMockMediaDevice("audioinput", "mic-2", "Microphone Two"),
      ])
      .mockResolvedValueOnce([
        createMockMediaDevice("audioinput", "mic-2", "Microphone Two"),
        createMockMediaDevice("audioinput", "mic-1", "Microphone One"),
        createMockMediaDevice("videoinput", "camera-2", "Camera Two"),
        createMockMediaDevice("videoinput", "camera-1", "Camera One"),
      ]);
    setMediaDevicesMock({
      enumerateDevices,
    });

    const recorder = renderUseVideoRecorder();

    await waitFor(() => {
      expect(recorder.latest.devices).toEqual({
        videoInputs: [
          { deviceId: "camera-1", label: "Camera One" },
          { deviceId: "camera-2", label: "Camera Two" },
        ],
        audioInputs: [
          { deviceId: "mic-1", label: "Microphone One" },
          { deviceId: "mic-2", label: "Microphone Two" },
        ],
      });
    });
    const previousDevices = recorder.latest.devices;

    await act(async () => {
      await recorder.latest.refreshDevices();
    });

    expect(recorder.latest.devices).toBe(previousDevices);
    expect(enumerateDevices).toHaveBeenCalledTimes(2);
  });

  it("filters out media devices with empty ids", async () => {
    setMediaRecorderSupport(["video/webm"]);
    const enumerateDevices = vi
      .fn()
      .mockResolvedValue([
        createMockMediaDevice("videoinput", "", "Hidden Camera"),
        createMockMediaDevice("videoinput", "   ", "Whitespace Camera"),
        createMockMediaDevice("videoinput", "camera-1", "Camera One"),
        createMockMediaDevice("audioinput", "", "Hidden Microphone"),
        createMockMediaDevice("audioinput", "mic-1", "Microphone One"),
      ]);
    setMediaDevicesMock({
      enumerateDevices,
    });

    const recorder = renderUseVideoRecorder();

    await waitFor(() => {
      expect(recorder.latest.devices).toEqual({
        videoInputs: [{ deviceId: "camera-1", label: "Camera One" }],
        audioInputs: [{ deviceId: "mic-1", label: "Microphone One" }],
      });
    });
  });

  it("deduplicates devices by id and prefers non-empty labels", async () => {
    setMediaRecorderSupport(["video/webm"]);
    const enumerateDevices = vi
      .fn()
      .mockResolvedValue([
        createMockMediaDevice("videoinput", " camera-1 ", ""),
        createMockMediaDevice("videoinput", "camera-1", "Front Camera"),
        createMockMediaDevice("audioinput", "mic-1 ", ""),
        createMockMediaDevice("audioinput", " mic-1", "Desk Microphone"),
      ]);
    setMediaDevicesMock({
      enumerateDevices,
    });

    const recorder = renderUseVideoRecorder();

    await waitFor(() => {
      expect(recorder.latest.devices).toEqual({
        videoInputs: [{ deviceId: "camera-1", label: "Front Camera" }],
        audioInputs: [{ deviceId: "mic-1", label: "Desk Microphone" }],
      });
    });
  });

  it("requests media permissions with settings constraints and refreshes devices", async () => {
    setMediaRecorderSupport(["video/webm"]);
    const trackStop = vi.fn();
    const permissionStream = {
      getTracks: () => [{ stop: trackStop }],
    } as unknown as MediaStream;
    const getUserMedia = vi.fn(async () => permissionStream);
    const enumerateDevices = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        createMockMediaDevice("videoinput", "camera-1", "Camera One"),
        createMockMediaDevice("audioinput", "mic-1", "Microphone One"),
      ]);

    setMediaDevicesMock({
      getUserMedia,
      enumerateDevices,
    });

    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: true,
        microphoneEnabled: true,
        selectedVideoDeviceId: "camera-1",
        selectedAudioDeviceId: "mic-1",
      });
    });

    await act(async () => {
      await recorder.latest.requestMediaPermissions();
    });

    expect(getUserMedia).toHaveBeenCalledWith({
      video: { deviceId: { exact: "camera-1" } },
      audio: { deviceId: { exact: "mic-1" } },
    });
    expect(trackStop).toHaveBeenCalledTimes(1);
    expect(enumerateDevices).toHaveBeenCalledTimes(2);

    await waitFor(() => {
      expect(recorder.latest.devices).toEqual({
        videoInputs: [{ deviceId: "camera-1", label: "Camera One" }],
        audioInputs: [{ deviceId: "mic-1", label: "Microphone One" }],
      });
    });

    expect(recorder.latest.error).toBeNull();
    expect(recorder.latest.isRequestingPermissions).toBe(false);
  });

  it("keeps permission request successful when temporary stream stop throws", async () => {
    setMediaRecorderSupport(["video/webm"]);
    const permissionStream = {
      getTracks: () => [
        {
          stop: () => {
            throw new Error("permission stream stop failed");
          },
        },
      ],
    } as unknown as MediaStream;
    const getUserMedia = vi.fn(async () => permissionStream);
    const enumerateDevices = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    setMediaDevicesMock({
      getUserMedia,
      enumerateDevices,
    });

    const recorder = renderUseVideoRecorder();

    await act(async () => {
      await recorder.latest.requestMediaPermissions();
    });

    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(recorder.latest.error).toBeNull();
    expect(recorder.latest.isRequestingPermissions).toBe(false);
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
  });

  it("maps permission denials when requesting media permissions", async () => {
    setMediaRecorderSupport(["video/webm"]);
    const denied = new DOMException("", "NotAllowedError");
    const getUserMedia = vi.fn(async () => {
      throw denied;
    });
    setMediaDevicesMock({
      enumerateDevices: vi.fn(async () => []),
      getUserMedia,
    });

    const recorder = renderUseVideoRecorder();

    await act(async () => {
      await recorder.latest.requestMediaPermissions();
    });

    await waitFor(() => {
      expect(recorder.latest.error).toBe(mapVideoRecorderErrorMessage(denied));
      expect(recorder.latest.isRequestingPermissions).toBe(false);
    });
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("falls back to default devices when selected permission devices are unavailable", async () => {
    setMediaRecorderSupport(["video/webm"]);
    const trackStop = vi.fn();
    const permissionStream = {
      getTracks: () => [{ stop: trackStop }],
    } as unknown as MediaStream;
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(new DOMException("", "NotFoundError"))
      .mockResolvedValueOnce(permissionStream);
    setMediaDevicesMock({
      enumerateDevices: vi.fn(async () => []),
      getUserMedia,
    });

    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: true,
        microphoneEnabled: false,
        selectedVideoDeviceId: "missing-camera",
        selectedAudioDeviceId: "keep-mic",
      });
    });

    await act(async () => {
      await recorder.latest.requestMediaPermissions();
    });

    expect(getUserMedia).toHaveBeenNthCalledWith(1, {
      video: { deviceId: { exact: "missing-camera" } },
      audio: false,
    });
    expect(getUserMedia).toHaveBeenNthCalledWith(2, {
      video: true,
      audio: false,
    });
    expect(trackStop).toHaveBeenCalledTimes(1);
    expect(recorder.latest.error).toBeNull();
    expect(recorder.latest.isRequestingPermissions).toBe(false);
    expect(recorder.latest.settings.selectedVideoDeviceId).toBeNull();
  });

  it("falls back on selected permission devices when error has selection name but is not DOMException", async () => {
    setMediaRecorderSupport(["video/webm"]);
    const notFoundLikeError = new Error("device missing");
    notFoundLikeError.name = "NotFoundError";
    const trackStop = vi.fn();
    const permissionStream = {
      getTracks: () => [{ stop: trackStop }],
    } as unknown as MediaStream;
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(notFoundLikeError)
      .mockResolvedValueOnce(permissionStream);
    setMediaDevicesMock({
      enumerateDevices: vi.fn(async () => []),
      getUserMedia,
    });

    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: true,
        microphoneEnabled: false,
        selectedVideoDeviceId: "missing-camera",
      });
    });

    await act(async () => {
      await recorder.latest.requestMediaPermissions();
    });

    expect(getUserMedia).toHaveBeenNthCalledWith(1, {
      video: { deviceId: { exact: "missing-camera" } },
      audio: false,
    });
    expect(getUserMedia).toHaveBeenNthCalledWith(2, {
      video: true,
      audio: false,
    });
    expect(trackStop).toHaveBeenCalledTimes(1);
    expect(recorder.latest.error).toBeNull();
    expect(recorder.latest.settings.selectedVideoDeviceId).toBeNull();
  });

  it("falls back on lowercase selection error names during permission request", async () => {
    setMediaRecorderSupport(["video/webm"]);
    const notFoundLikeError = new Error("device missing");
    notFoundLikeError.name = "notfounderror";
    const trackStop = vi.fn();
    const permissionStream = {
      getTracks: () => [{ stop: trackStop }],
    } as unknown as MediaStream;
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(notFoundLikeError)
      .mockResolvedValueOnce(permissionStream);
    setMediaDevicesMock({
      enumerateDevices: vi.fn(async () => []),
      getUserMedia,
    });

    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: true,
        microphoneEnabled: false,
        selectedVideoDeviceId: "missing-camera-lowercase",
      });
    });

    await act(async () => {
      await recorder.latest.requestMediaPermissions();
    });

    expect(getUserMedia).toHaveBeenNthCalledWith(1, {
      video: { deviceId: { exact: "missing-camera-lowercase" } },
      audio: false,
    });
    expect(getUserMedia).toHaveBeenNthCalledWith(2, {
      video: true,
      audio: false,
    });
    expect(trackStop).toHaveBeenCalledTimes(1);
    expect(recorder.latest.error).toBeNull();
    expect(recorder.latest.settings.selectedVideoDeviceId).toBeNull();
  });

  it("falls back on legacy constraint error aliases during permission request", async () => {
    setMediaRecorderSupport(["video/webm"]);
    const constraintError = new Error("constraint mismatch");
    constraintError.name = "ConstraintNotSatisfiedError";
    const trackStop = vi.fn();
    const permissionStream = {
      getTracks: () => [{ stop: trackStop }],
    } as unknown as MediaStream;
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(constraintError)
      .mockResolvedValueOnce(permissionStream);
    setMediaDevicesMock({
      enumerateDevices: vi.fn(async () => []),
      getUserMedia,
    });

    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: true,
        microphoneEnabled: false,
        selectedVideoDeviceId: "legacy-missing-camera",
      });
    });

    await act(async () => {
      await recorder.latest.requestMediaPermissions();
    });

    expect(getUserMedia).toHaveBeenNthCalledWith(1, {
      video: { deviceId: { exact: "legacy-missing-camera" } },
      audio: false,
    });
    expect(getUserMedia).toHaveBeenNthCalledWith(2, {
      video: true,
      audio: false,
    });
    expect(trackStop).toHaveBeenCalledTimes(1);
    expect(recorder.latest.error).toBeNull();
    expect(recorder.latest.settings.selectedVideoDeviceId).toBeNull();
  });

  it("falls back on devices-not-found alias during permission request", async () => {
    setMediaRecorderSupport(["video/webm"]);
    const notFoundAliasError = new Error("devices not found");
    notFoundAliasError.name = "DevicesNotFoundError";
    const trackStop = vi.fn();
    const permissionStream = {
      getTracks: () => [{ stop: trackStop }],
    } as unknown as MediaStream;
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(notFoundAliasError)
      .mockResolvedValueOnce(permissionStream);
    setMediaDevicesMock({
      enumerateDevices: vi.fn(async () => []),
      getUserMedia,
    });

    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: true,
        microphoneEnabled: false,
        selectedVideoDeviceId: "alias-missing-camera",
      });
    });

    await act(async () => {
      await recorder.latest.requestMediaPermissions();
    });

    expect(getUserMedia).toHaveBeenNthCalledWith(1, {
      video: { deviceId: { exact: "alias-missing-camera" } },
      audio: false,
    });
    expect(getUserMedia).toHaveBeenNthCalledWith(2, {
      video: true,
      audio: false,
    });
    expect(trackStop).toHaveBeenCalledTimes(1);
    expect(recorder.latest.error).toBeNull();
    expect(recorder.latest.settings.selectedVideoDeviceId).toBeNull();
  });

  it("falls back on selection errors inferred from permission error messages", async () => {
    setMediaRecorderSupport(["video/webm"]);
    const notFoundMessageError = new Error(
      "Requested device not found for selected input.",
    );
    const trackStop = vi.fn();
    const permissionStream = {
      getTracks: () => [{ stop: trackStop }],
    } as unknown as MediaStream;
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(notFoundMessageError)
      .mockResolvedValueOnce(permissionStream);
    setMediaDevicesMock({
      enumerateDevices: vi.fn(async () => []),
      getUserMedia,
    });

    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: true,
        microphoneEnabled: false,
        selectedVideoDeviceId: "message-missing-camera",
      });
    });

    await act(async () => {
      await recorder.latest.requestMediaPermissions();
    });

    expect(getUserMedia).toHaveBeenNthCalledWith(1, {
      video: { deviceId: { exact: "message-missing-camera" } },
      audio: false,
    });
    expect(getUserMedia).toHaveBeenNthCalledWith(2, {
      video: true,
      audio: false,
    });
    expect(trackStop).toHaveBeenCalledTimes(1);
    expect(recorder.latest.error).toBeNull();
    expect(recorder.latest.settings.selectedVideoDeviceId).toBeNull();
  });

  it("falls back when permission error message says cannot find selected device", async () => {
    setMediaRecorderSupport(["video/webm"]);
    const notFoundMessageError = new Error(
      "Cannot find selected input device for capture.",
    );
    const trackStop = vi.fn();
    const permissionStream = {
      getTracks: () => [{ stop: trackStop }],
    } as unknown as MediaStream;
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(notFoundMessageError)
      .mockResolvedValueOnce(permissionStream);
    setMediaDevicesMock({
      enumerateDevices: vi.fn(async () => []),
      getUserMedia,
    });

    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: true,
        microphoneEnabled: false,
        selectedVideoDeviceId: "cannot-find-camera",
      });
    });

    await act(async () => {
      await recorder.latest.requestMediaPermissions();
    });

    expect(getUserMedia).toHaveBeenNthCalledWith(1, {
      video: { deviceId: { exact: "cannot-find-camera" } },
      audio: false,
    });
    expect(getUserMedia).toHaveBeenNthCalledWith(2, {
      video: true,
      audio: false,
    });
    expect(trackStop).toHaveBeenCalledTimes(1);
    expect(recorder.latest.error).toBeNull();
    expect(recorder.latest.settings.selectedVideoDeviceId).toBeNull();
  });

  it("keeps non-requested selected audio device on camera-only permission fallback", async () => {
    setMediaRecorderSupport(["video/webm"]);
    const trackStop = vi.fn();
    const permissionStream = {
      getTracks: () => [{ stop: trackStop }],
    } as unknown as MediaStream;
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(new DOMException("", "NotFoundError"))
      .mockResolvedValueOnce(permissionStream);
    setMediaDevicesMock({
      enumerateDevices: vi.fn(async () => []),
      getUserMedia,
    });

    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: true,
        microphoneEnabled: false,
        selectedVideoDeviceId: "missing-camera",
        selectedAudioDeviceId: "keep-mic",
      });
    });

    await act(async () => {
      await recorder.latest.requestMediaPermissions();
    });

    expect(getUserMedia).toHaveBeenNthCalledWith(1, {
      video: { deviceId: { exact: "missing-camera" } },
      audio: false,
    });
    expect(getUserMedia).toHaveBeenNthCalledWith(2, {
      video: true,
      audio: false,
    });
    expect(trackStop).toHaveBeenCalledTimes(1);
    expect(recorder.latest.error).toBeNull();
    expect(recorder.latest.settings.selectedVideoDeviceId).toBeNull();
    expect(recorder.latest.settings.selectedAudioDeviceId).toBe("keep-mic");
  });

  it("keeps non-requested selected video device on microphone-only permission fallback", async () => {
    setMediaRecorderSupport(["video/webm"]);
    const trackStop = vi.fn();
    const permissionStream = {
      getTracks: () => [{ stop: trackStop }],
    } as unknown as MediaStream;
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(new DOMException("", "NotFoundError"))
      .mockResolvedValueOnce(permissionStream);
    setMediaDevicesMock({
      enumerateDevices: vi.fn(async () => []),
      getUserMedia,
    });

    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: true,
        selectedVideoDeviceId: "keep-camera",
        selectedAudioDeviceId: "missing-mic",
      });
    });

    await act(async () => {
      await recorder.latest.requestMediaPermissions();
    });

    expect(getUserMedia).toHaveBeenNthCalledWith(1, {
      video: false,
      audio: { deviceId: { exact: "missing-mic" } },
    });
    expect(getUserMedia).toHaveBeenNthCalledWith(2, {
      video: false,
      audio: true,
    });
    expect(trackStop).toHaveBeenCalledTimes(1);
    expect(recorder.latest.error).toBeNull();
    expect(recorder.latest.settings.selectedAudioDeviceId).toBeNull();
    expect(recorder.latest.settings.selectedVideoDeviceId).toBe("keep-camera");
  });

  it("does not retry permission request on non-selection errors", async () => {
    setMediaRecorderSupport(["video/webm"]);
    const denied = new DOMException("", "NotAllowedError");
    const getUserMedia = vi.fn().mockRejectedValue(denied);
    setMediaDevicesMock({
      enumerateDevices: vi.fn(async () => []),
      getUserMedia,
    });

    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: true,
        microphoneEnabled: false,
        selectedVideoDeviceId: "camera-1",
      });
    });

    await act(async () => {
      await recorder.latest.requestMediaPermissions();
    });

    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(getUserMedia).toHaveBeenCalledWith({
      video: { deviceId: { exact: "camera-1" } },
      audio: false,
    });
    expect(recorder.latest.error).toBe(mapVideoRecorderErrorMessage(denied));
    expect(recorder.latest.settings.selectedVideoDeviceId).toBe("camera-1");
  });

  it("clears stale selected device when permission fallback also fails", async () => {
    setMediaRecorderSupport(["video/webm"]);
    const notFound = new DOMException("", "NotFoundError");
    const getUserMedia = vi.fn().mockRejectedValue(notFound);
    setMediaDevicesMock({
      enumerateDevices: vi.fn(async () => []),
      getUserMedia,
    });

    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: true,
        microphoneEnabled: false,
        selectedVideoDeviceId: "stale-camera",
      });
    });

    await act(async () => {
      await recorder.latest.requestMediaPermissions();
    });

    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(getUserMedia).toHaveBeenNthCalledWith(1, {
      video: { deviceId: { exact: "stale-camera" } },
      audio: false,
    });
    expect(getUserMedia).toHaveBeenNthCalledWith(2, {
      video: true,
      audio: false,
    });
    expect(recorder.latest.error).toBe(mapVideoRecorderErrorMessage(notFound));
    expect(recorder.latest.settings.selectedVideoDeviceId).toBeNull();
    expect(recorder.latest.isRequestingPermissions).toBe(false);
  });

  it("clears stale selected microphone when permission fallback also fails", async () => {
    setMediaRecorderSupport(["video/webm"]);
    const notFound = new DOMException("", "NotFoundError");
    const getUserMedia = vi.fn().mockRejectedValue(notFound);
    setMediaDevicesMock({
      enumerateDevices: vi.fn(async () => []),
      getUserMedia,
    });

    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: true,
        selectedAudioDeviceId: "stale-mic",
      });
    });

    await act(async () => {
      await recorder.latest.requestMediaPermissions();
    });

    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(getUserMedia).toHaveBeenNthCalledWith(1, {
      video: false,
      audio: { deviceId: { exact: "stale-mic" } },
    });
    expect(getUserMedia).toHaveBeenNthCalledWith(2, {
      video: false,
      audio: true,
    });
    expect(recorder.latest.error).toBe(mapVideoRecorderErrorMessage(notFound));
    expect(recorder.latest.settings.selectedAudioDeviceId).toBeNull();
    expect(recorder.latest.isRequestingPermissions).toBe(false);
  });

  it("keeps both selected devices when permission fallback cannot disambiguate stale side", async () => {
    setMediaRecorderSupport(["video/webm"]);
    const trackStop = vi.fn();
    const permissionStream = {
      getTracks: () => [{ stop: trackStop }],
    } as unknown as MediaStream;
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(new DOMException("", "NotFoundError"))
      .mockResolvedValueOnce(permissionStream);
    setMediaDevicesMock({
      enumerateDevices: vi.fn(async () => []),
      getUserMedia,
    });

    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: true,
        microphoneEnabled: true,
        selectedVideoDeviceId: "missing-camera",
        selectedAudioDeviceId: "missing-mic",
      });
    });

    await act(async () => {
      await recorder.latest.requestMediaPermissions();
    });

    expect(getUserMedia).toHaveBeenNthCalledWith(1, {
      video: { deviceId: { exact: "missing-camera" } },
      audio: { deviceId: { exact: "missing-mic" } },
    });
    expect(getUserMedia).toHaveBeenNthCalledWith(2, {
      video: true,
      audio: true,
    });
    expect(trackStop).toHaveBeenCalledTimes(1);
    expect(recorder.latest.error).toBeNull();
    expect(recorder.latest.settings.selectedVideoDeviceId).toBe(
      "missing-camera",
    );
    expect(recorder.latest.settings.selectedAudioDeviceId).toBe("missing-mic");
  });

  it("keeps both selected devices when dual-device permission fallback also fails", async () => {
    setMediaRecorderSupport(["video/webm"]);
    const notFound = new DOMException("", "NotFoundError");
    const getUserMedia = vi.fn().mockRejectedValue(notFound);
    setMediaDevicesMock({
      enumerateDevices: vi.fn(async () => []),
      getUserMedia,
    });

    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: true,
        microphoneEnabled: true,
        selectedVideoDeviceId: "missing-camera",
        selectedAudioDeviceId: "missing-mic",
      });
    });

    await act(async () => {
      await recorder.latest.requestMediaPermissions();
    });

    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(getUserMedia).toHaveBeenNthCalledWith(1, {
      video: { deviceId: { exact: "missing-camera" } },
      audio: { deviceId: { exact: "missing-mic" } },
    });
    expect(getUserMedia).toHaveBeenNthCalledWith(2, {
      video: true,
      audio: true,
    });
    expect(recorder.latest.error).toBe(mapVideoRecorderErrorMessage(notFound));
    expect(recorder.latest.settings.selectedVideoDeviceId).toBe(
      "missing-camera",
    );
    expect(recorder.latest.settings.selectedAudioDeviceId).toBe("missing-mic");
    expect(recorder.latest.isRequestingPermissions).toBe(false);
  });

  it("reconciles dual-device stale selections after fallback failure when devices can be enumerated", async () => {
    setMediaRecorderSupport(["video/webm"]);
    const notFound = new DOMException("", "NotFoundError");
    const getUserMedia = vi.fn().mockRejectedValue(notFound);
    const enumerateDevices = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        createMockMediaDevice("videoinput", "camera-1", "Camera One"),
        createMockMediaDevice("audioinput", "mic-1", "Microphone One"),
      ]);
    setMediaDevicesMock({
      enumerateDevices,
      getUserMedia,
    });

    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: true,
        microphoneEnabled: true,
        selectedVideoDeviceId: "missing-camera",
        selectedAudioDeviceId: "missing-mic",
      });
    });

    await act(async () => {
      await recorder.latest.requestMediaPermissions();
    });

    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(recorder.latest.error).toBe(mapVideoRecorderErrorMessage(notFound));
    expect(enumerateDevices).toHaveBeenCalledTimes(2);
    expect(recorder.latest.settings.selectedVideoDeviceId).toBeNull();
    expect(recorder.latest.settings.selectedAudioDeviceId).toBeNull();
    expect(recorder.latest.isRequestingPermissions).toBe(false);
  });

  it("does not block permission retries while refresh reconciliation is pending", async () => {
    setMediaRecorderSupport(["video/webm"]);
    const pendingRefreshResolvers: Array<(value: MediaDeviceInfo[]) => void> =
      [];
    const enumerateDevices = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockImplementation(
        () =>
          new Promise<MediaDeviceInfo[]>((resolve) => {
            pendingRefreshResolvers.push(resolve);
          }),
      );
    const notFound = new DOMException("", "NotFoundError");
    const getUserMedia = vi.fn().mockRejectedValue(notFound);
    setMediaDevicesMock({
      enumerateDevices,
      getUserMedia,
    });

    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: true,
        microphoneEnabled: false,
        selectedVideoDeviceId: "stale-camera",
      });
    });

    act(() => {
      void recorder.latest.requestMediaPermissions();
    });

    await waitFor(() => {
      expect(recorder.latest.error).toBe(
        mapVideoRecorderErrorMessage(notFound),
      );
      expect(recorder.latest.isRequestingPermissions).toBe(false);
    });
    expect(getUserMedia).toHaveBeenCalledTimes(2);

    act(() => {
      void recorder.latest.requestMediaPermissions();
    });

    await waitFor(() => {
      expect(getUserMedia).toHaveBeenCalledTimes(3);
      expect(recorder.latest.isRequestingPermissions).toBe(false);
    });
    expect(getUserMedia).toHaveBeenNthCalledWith(3, {
      video: true,
      audio: false,
    });

    pendingRefreshResolvers.forEach((resolve) => resolve([]));
    await act(async () => {
      await Promise.resolve();
    });
  });

  it("does not clear a newly selected device if permission fallback resolves later", async () => {
    setMediaRecorderSupport(["video/webm"]);
    const trackStop = vi.fn();
    const permissionStream = {
      getTracks: () => [{ stop: trackStop }],
    } as unknown as MediaStream;
    let resolveFallbackRequest: ((value: MediaStream) => void) | null = null;
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(new DOMException("", "NotFoundError"))
      .mockImplementationOnce(
        () =>
          new Promise<MediaStream>((resolve) => {
            resolveFallbackRequest = resolve;
          }),
      );
    setMediaDevicesMock({
      enumerateDevices: vi.fn(async () => []),
      getUserMedia,
    });

    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: true,
        microphoneEnabled: false,
        selectedVideoDeviceId: "stale-camera",
      });
    });

    act(() => {
      void recorder.latest.requestMediaPermissions();
    });
    await waitFor(() => {
      expect(getUserMedia).toHaveBeenCalledTimes(2);
    });

    act(() => {
      recorder.latest.setSettings({
        selectedVideoDeviceId: "new-camera",
      });
    });

    await act(async () => {
      resolveFallbackRequest?.(permissionStream);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(recorder.latest.error).toBeNull();
      expect(recorder.latest.isRequestingPermissions).toBe(false);
      expect(recorder.latest.settings.selectedVideoDeviceId).toBe("new-camera");
    });
    expect(trackStop).toHaveBeenCalledTimes(1);
  });

  it("preserves selected camera when camera gets disabled before permission fallback resolves", async () => {
    setMediaRecorderSupport(["video/webm"]);
    const trackStop = vi.fn();
    const permissionStream = {
      getTracks: () => [{ stop: trackStop }],
    } as unknown as MediaStream;
    let rejectPrimaryRequest: ((reason?: unknown) => void) | null = null;
    const getUserMedia = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<MediaStream>((_resolve, reject) => {
            rejectPrimaryRequest = reject;
          }),
      )
      .mockResolvedValueOnce(permissionStream);
    setMediaDevicesMock({
      enumerateDevices: vi.fn(async () => []),
      getUserMedia,
    });

    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: true,
        microphoneEnabled: false,
        selectedVideoDeviceId: "stale-camera",
      });
    });

    act(() => {
      void recorder.latest.requestMediaPermissions();
    });
    await waitFor(() => {
      expect(getUserMedia).toHaveBeenCalledTimes(1);
      expect(recorder.latest.isRequestingPermissions).toBe(true);
    });

    act(() => {
      recorder.latest.setSettings({ cameraEnabled: false });
    });

    await act(async () => {
      rejectPrimaryRequest?.(new DOMException("", "NotFoundError"));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(getUserMedia).toHaveBeenCalledTimes(2);
      expect(recorder.latest.isRequestingPermissions).toBe(false);
      expect(recorder.latest.error).toBeNull();
      expect(recorder.latest.settings.selectedVideoDeviceId).toBe(
        "stale-camera",
      );
    });
    expect(trackStop).toHaveBeenCalledTimes(1);
  });

  it("preserves selected microphone when microphone gets disabled before permission fallback resolves", async () => {
    setMediaRecorderSupport(["video/webm"]);
    const trackStop = vi.fn();
    const permissionStream = {
      getTracks: () => [{ stop: trackStop }],
    } as unknown as MediaStream;
    let rejectPrimaryRequest: ((reason?: unknown) => void) | null = null;
    const getUserMedia = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<MediaStream>((_resolve, reject) => {
            rejectPrimaryRequest = reject;
          }),
      )
      .mockResolvedValueOnce(permissionStream);
    setMediaDevicesMock({
      enumerateDevices: vi.fn(async () => []),
      getUserMedia,
    });

    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: true,
        selectedAudioDeviceId: "stale-mic",
      });
    });

    act(() => {
      void recorder.latest.requestMediaPermissions();
    });
    await waitFor(() => {
      expect(getUserMedia).toHaveBeenCalledTimes(1);
      expect(recorder.latest.isRequestingPermissions).toBe(true);
    });

    act(() => {
      recorder.latest.setSettings({ microphoneEnabled: false });
    });

    await act(async () => {
      rejectPrimaryRequest?.(new DOMException("", "NotFoundError"));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(getUserMedia).toHaveBeenCalledTimes(2);
      expect(recorder.latest.isRequestingPermissions).toBe(false);
      expect(recorder.latest.error).toBeNull();
      expect(recorder.latest.settings.selectedAudioDeviceId).toBe("stale-mic");
    });
    expect(trackStop).toHaveBeenCalledTimes(1);
  });

  it("does not retry permission request when no specific device constraints were requested", async () => {
    setMediaRecorderSupport(["video/webm"]);
    const notFound = new DOMException("", "NotFoundError");
    const getUserMedia = vi.fn().mockRejectedValue(notFound);
    setMediaDevicesMock({
      enumerateDevices: vi.fn(async () => []),
      getUserMedia,
    });

    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
        selectedVideoDeviceId: "stale-camera",
        selectedAudioDeviceId: "stale-mic",
      });
    });

    await act(async () => {
      await recorder.latest.requestMediaPermissions();
    });

    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(getUserMedia).toHaveBeenCalledWith({
      video: true,
      audio: true,
    });
    expect(recorder.latest.error).toBe(mapVideoRecorderErrorMessage(notFound));
    expect(recorder.latest.isRequestingPermissions).toBe(false);
  });

  it("requests both audio and video as fallback when all devices are disabled", async () => {
    setMediaRecorderSupport(["video/webm"]);
    const stopTrack = vi.fn();
    const permissionStream = {
      getTracks: () => [{ stop: stopTrack }],
    } as unknown as MediaStream;
    const getUserMedia = vi.fn(async () => permissionStream);
    setMediaDevicesMock({
      enumerateDevices: vi.fn(async () => []),
      getUserMedia,
    });

    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.requestMediaPermissions();
    });

    expect(getUserMedia).toHaveBeenCalledWith({
      video: true,
      audio: true,
    });
    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(recorder.latest.error).toBeNull();
    expect(recorder.latest.isRequestingPermissions).toBe(false);
  });

  it("tracks requesting-permissions state during async permission flow", async () => {
    setMediaRecorderSupport(["video/webm"]);
    const stopTrack = vi.fn();
    const permissionStream = {
      getTracks: () => [{ stop: stopTrack }],
    } as unknown as MediaStream;
    let resolvePermission: ((value: MediaStream) => void) | null = null;
    const getUserMedia = vi.fn(
      () =>
        new Promise<MediaStream>((resolve) => {
          resolvePermission = resolve;
        }),
    );
    setMediaDevicesMock({
      enumerateDevices: vi.fn(async () => []),
      getUserMedia,
    });

    const recorder = renderUseVideoRecorder();

    act(() => {
      void recorder.latest.requestMediaPermissions();
    });

    await waitFor(() => {
      expect(recorder.latest.isRequestingPermissions).toBe(true);
    });
    expect(getUserMedia).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolvePermission?.(permissionStream);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(recorder.latest.isRequestingPermissions).toBe(false);
      expect(recorder.latest.error).toBeNull();
    });
    expect(stopTrack).toHaveBeenCalledTimes(1);
  });

  it("stops pending permission stream when request resolves after unmount", async () => {
    setMediaRecorderSupport(["video/webm"]);
    const stopTrack = vi.fn();
    const permissionStream = {
      getTracks: () => [{ stop: stopTrack }],
    } as unknown as MediaStream;
    let resolvePermission: ((value: MediaStream) => void) | null = null;
    const getUserMedia = vi.fn(
      () =>
        new Promise<MediaStream>((resolve) => {
          resolvePermission = resolve;
        }),
    );
    const enumerateDevices = vi.fn(async () => []);
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    setMediaDevicesMock({
      enumerateDevices,
      getUserMedia,
    });

    const recorder = renderUseVideoRecorder();

    act(() => {
      void recorder.latest.requestMediaPermissions();
    });
    await waitFor(() => {
      expect(getUserMedia).toHaveBeenCalledTimes(1);
      expect(recorder.latest.isRequestingPermissions).toBe(true);
    });

    act(() => {
      recorder.unmount();
    });

    await act(async () => {
      resolvePermission?.(permissionStream);
      await Promise.resolve();
    });

    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(enumerateDevices).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("ignores permission rejection after unmount without polluting logs", async () => {
    setMediaRecorderSupport(["video/webm"]);
    let rejectPermission: ((reason?: unknown) => void) | null = null;
    const getUserMedia = vi.fn(
      () =>
        new Promise<MediaStream>((_resolve, reject) => {
          rejectPermission = reject;
        }),
    );
    const enumerateDevices = vi.fn(async () => []);
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    setMediaDevicesMock({
      enumerateDevices,
      getUserMedia,
    });

    const recorder = renderUseVideoRecorder();

    act(() => {
      void recorder.latest.requestMediaPermissions();
    });
    await waitFor(() => {
      expect(getUserMedia).toHaveBeenCalledTimes(1);
      expect(recorder.latest.isRequestingPermissions).toBe(true);
    });

    act(() => {
      recorder.unmount();
    });

    await act(async () => {
      rejectPermission?.(new DOMException("", "NotAllowedError"));
      await Promise.resolve();
    });

    expect(enumerateDevices).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("ignores duplicate permission requests while one is in flight", async () => {
    setMediaRecorderSupport(["video/webm"]);
    const stopTrack = vi.fn();
    const permissionStream = {
      getTracks: () => [{ stop: stopTrack }],
    } as unknown as MediaStream;
    let resolvePermission: ((value: MediaStream) => void) | null = null;
    const getUserMedia = vi.fn(
      () =>
        new Promise<MediaStream>((resolve) => {
          resolvePermission = resolve;
        }),
    );
    setMediaDevicesMock({
      enumerateDevices: vi.fn(async () => []),
      getUserMedia,
    });

    const recorder = renderUseVideoRecorder();

    act(() => {
      void recorder.latest.requestMediaPermissions();
      void recorder.latest.requestMediaPermissions();
    });

    await waitFor(() => {
      expect(recorder.latest.isRequestingPermissions).toBe(true);
    });
    expect(getUserMedia).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolvePermission?.(permissionStream);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(recorder.latest.isRequestingPermissions).toBe(false);
      expect(recorder.latest.error).toBeNull();
    });
    expect(stopTrack).toHaveBeenCalledTimes(1);
  });

  it("ignores start requests while permissions request is in flight", async () => {
    setMediaRecorderSupport(["video/webm"]);
    const stopTrack = vi.fn();
    const permissionStream = {
      getTracks: () => [{ stop: stopTrack }],
    } as unknown as MediaStream;
    let resolvePermission: ((value: MediaStream) => void) | null = null;
    const getUserMedia = vi.fn(
      () =>
        new Promise<MediaStream>((resolve) => {
          resolvePermission = resolve;
        }),
    );
    setMediaDevicesMock({
      enumerateDevices: vi.fn(async () => []),
      getUserMedia,
    });

    const recorder = renderUseVideoRecorder();
    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: true,
        microphoneEnabled: false,
      });
    });

    act(() => {
      void recorder.latest.requestMediaPermissions();
    });
    await waitFor(() => {
      expect(recorder.latest.isRequestingPermissions).toBe(true);
      expect(getUserMedia).toHaveBeenCalledTimes(1);
    });

    act(() => {
      void recorder.latest.startRecording();
    });

    expect(recorder.latest.status).toBe("idle");
    expect(getUserMedia).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolvePermission?.(permissionStream);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(recorder.latest.isRequestingPermissions).toBe(false);
      expect(recorder.latest.error).toBeNull();
    });
    expect(stopTrack).toHaveBeenCalledTimes(1);
  });

  it("ignores permission requests while start flow is in flight", async () => {
    setMediaRecorderSupport(["video/webm"]);
    const { cleanup } = createExcalidrawCanvases();
    const enumerateDevices = vi.fn(async () => []);
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    let rejectStart: ((reason?: unknown) => void) | null = null;
    const getUserMedia = vi.fn(
      () =>
        new Promise<MediaStream>((_resolve, reject) => {
          rejectStart = reject;
        }),
    );
    setMediaDevicesMock({
      enumerateDevices,
      getUserMedia,
    });

    const recorder = renderUseVideoRecorder();
    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: true,
        microphoneEnabled: false,
      });
    });

    act(() => {
      void recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("preparing");
      expect(getUserMedia).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      await recorder.latest.requestMediaPermissions();
    });

    expect(recorder.latest.isRequestingPermissions).toBe(false);
    expect(getUserMedia).toHaveBeenCalledTimes(1);

    await act(async () => {
      rejectStart?.(new DOMException("", "NotAllowedError"));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
    });
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    expect(enumerateDevices).toHaveBeenCalledTimes(1);

    cleanup();
  });

  it("ignores permission requests while recorder is active", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();
    const getUserMedia = navigator.mediaDevices
      .getUserMedia as unknown as ReturnType<typeof vi.fn>;

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    await act(async () => {
      await recorder.latest.requestMediaPermissions();
    });

    expect(recorder.latest.status).toBe("recording");
    expect(recorder.latest.isRequestingPermissions).toBe(false);
    expect(getUserMedia).toHaveBeenCalledTimes(0);

    await act(async () => {
      await recorder.latest.stopRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("completed");
    });

    setup.cleanupCanvases();
  });

  it("ignores permission requests while recorder is paused", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();
    const getUserMedia = navigator.mediaDevices
      .getUserMedia as unknown as ReturnType<typeof vi.fn>;

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      recorder.latest.pauseRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("paused");
    });

    await act(async () => {
      await recorder.latest.requestMediaPermissions();
    });

    expect(recorder.latest.status).toBe("paused");
    expect(recorder.latest.isRequestingPermissions).toBe(false);
    expect(getUserMedia).toHaveBeenCalledTimes(0);

    await act(async () => {
      await recorder.latest.stopRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("completed");
    });

    setup.cleanupCanvases();
  });

  it("ignores permission requests while recorder is stopping", async () => {
    const setup = setupRecordingFlowMocks({
      deferStop: true,
    });
    const recorder = renderUseVideoRecorder();
    const getUserMedia = navigator.mediaDevices
      .getUserMedia as unknown as ReturnType<typeof vi.fn>;

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      void recorder.latest.stopRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("stopping");
    });

    await act(async () => {
      await recorder.latest.requestMediaPermissions();
    });

    expect(recorder.latest.status).toBe("stopping");
    expect(recorder.latest.isRequestingPermissions).toBe(false);
    expect(getUserMedia).toHaveBeenCalledTimes(0);

    act(() => {
      setup.flushStop();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("completed");
    });

    setup.cleanupCanvases();
  });

  it("handles device enumeration failures without breaking recorder state", async () => {
    setMediaRecorderSupport(["video/webm"]);
    const enumerateDevices = vi.fn(async () => {
      throw new Error("enumerate failed");
    });
    setMediaDevicesMock({
      enumerateDevices,
    });
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    const recorder = renderUseVideoRecorder();

    await waitFor(() => {
      expect(enumerateDevices).toHaveBeenCalledTimes(1);
      expect(recorder.latest.devices).toEqual({
        videoInputs: [],
        audioInputs: [],
      });
    });

    await act(async () => {
      await recorder.latest.refreshDevices();
    });

    expect(enumerateDevices).toHaveBeenCalledTimes(2);
    expect(consoleErrorSpy).toHaveBeenCalledTimes(2);
    expect(recorder.latest.status).toBe("idle");
    expect(recorder.latest.error).toBeNull();
  });

  it("clears stale selected device ids when refreshed device lists no longer contain them", async () => {
    setMediaRecorderSupport(["video/webm"]);
    const enumerateDevices = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        createMockMediaDevice("videoinput", "camera-1", "Camera One"),
        createMockMediaDevice("audioinput", "mic-1", "Microphone One"),
      ]);
    setMediaDevicesMock({
      enumerateDevices,
    });

    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        selectedVideoDeviceId: "stale-camera",
        selectedAudioDeviceId: "stale-mic",
      });
    });
    expect(recorder.latest.settings.selectedVideoDeviceId).toBe("stale-camera");
    expect(recorder.latest.settings.selectedAudioDeviceId).toBe("stale-mic");

    await act(async () => {
      await recorder.latest.refreshDevices();
    });

    await waitFor(() => {
      expect(recorder.latest.settings.selectedVideoDeviceId).toBeNull();
      expect(recorder.latest.settings.selectedAudioDeviceId).toBeNull();
    });
  });

  it("keeps selected device ids when refreshed device lists are empty", async () => {
    setMediaRecorderSupport(["video/webm"]);
    const enumerateDevices = vi.fn().mockResolvedValue([]);
    setMediaDevicesMock({
      enumerateDevices,
    });

    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        selectedVideoDeviceId: "camera-preferred",
        selectedAudioDeviceId: "mic-preferred",
      });
    });

    await act(async () => {
      await recorder.latest.refreshDevices();
    });

    expect(recorder.latest.settings.selectedVideoDeviceId).toBe(
      "camera-preferred",
    );
    expect(recorder.latest.settings.selectedAudioDeviceId).toBe(
      "mic-preferred",
    );
  });

  it("clears stale microphone selection when only camera devices are available", async () => {
    setMediaRecorderSupport(["video/webm"]);
    const enumerateDevices = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        createMockMediaDevice("videoinput", "camera-1", "Camera One"),
      ]);
    setMediaDevicesMock({
      enumerateDevices,
    });

    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        selectedVideoDeviceId: "camera-1",
        selectedAudioDeviceId: "stale-mic",
      });
    });

    await act(async () => {
      await recorder.latest.refreshDevices();
    });

    await waitFor(() => {
      expect(recorder.latest.settings.selectedVideoDeviceId).toBe("camera-1");
      expect(recorder.latest.settings.selectedAudioDeviceId).toBeNull();
    });
  });

  it("preserves selected microphone when microphone is disabled and only camera devices are available", async () => {
    setMediaRecorderSupport(["video/webm"]);
    const enumerateDevices = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        createMockMediaDevice("videoinput", "camera-1", "Camera One"),
      ]);
    setMediaDevicesMock({
      enumerateDevices,
    });

    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        microphoneEnabled: false,
        selectedVideoDeviceId: "camera-1",
        selectedAudioDeviceId: "preferred-mic",
      });
    });

    await act(async () => {
      await recorder.latest.refreshDevices();
    });

    await waitFor(() => {
      expect(recorder.latest.settings.selectedVideoDeviceId).toBe("camera-1");
      expect(recorder.latest.settings.selectedAudioDeviceId).toBe(
        "preferred-mic",
      );
    });
  });

  it("clears stale selected microphone when microphone is disabled but microphone devices are available", async () => {
    setMediaRecorderSupport(["video/webm"]);
    const enumerateDevices = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        createMockMediaDevice("videoinput", "camera-1", "Camera One"),
        createMockMediaDevice("audioinput", "mic-1", "Microphone One"),
      ]);
    setMediaDevicesMock({
      enumerateDevices,
    });

    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        microphoneEnabled: false,
        selectedVideoDeviceId: "camera-1",
        selectedAudioDeviceId: "stale-mic",
      });
    });

    await act(async () => {
      await recorder.latest.refreshDevices();
    });

    await waitFor(() => {
      expect(recorder.latest.settings.selectedVideoDeviceId).toBe("camera-1");
      expect(recorder.latest.settings.selectedAudioDeviceId).toBeNull();
    });
  });

  it("clears stale camera selection when only microphone devices are available", async () => {
    setMediaRecorderSupport(["video/webm"]);
    const enumerateDevices = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        createMockMediaDevice("audioinput", "mic-1", "Microphone One"),
      ]);
    setMediaDevicesMock({
      enumerateDevices,
    });

    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: true,
        selectedVideoDeviceId: "stale-camera",
        selectedAudioDeviceId: "mic-1",
      });
    });

    await act(async () => {
      await recorder.latest.refreshDevices();
    });

    await waitFor(() => {
      expect(recorder.latest.settings.selectedVideoDeviceId).toBeNull();
      expect(recorder.latest.settings.selectedAudioDeviceId).toBe("mic-1");
    });
  });

  it("preserves selected camera when camera is disabled and only microphone devices are available", async () => {
    setMediaRecorderSupport(["video/webm"]);
    const enumerateDevices = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        createMockMediaDevice("audioinput", "mic-1", "Microphone One"),
      ]);
    setMediaDevicesMock({
      enumerateDevices,
    });

    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        selectedVideoDeviceId: "preferred-camera",
        selectedAudioDeviceId: "mic-1",
      });
    });

    await act(async () => {
      await recorder.latest.refreshDevices();
    });

    await waitFor(() => {
      expect(recorder.latest.settings.selectedVideoDeviceId).toBe(
        "preferred-camera",
      );
      expect(recorder.latest.settings.selectedAudioDeviceId).toBe("mic-1");
    });
  });

  it("clears stale selected camera when camera is disabled but camera devices are available", async () => {
    setMediaRecorderSupport(["video/webm"]);
    const enumerateDevices = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        createMockMediaDevice("videoinput", "camera-1", "Camera One"),
        createMockMediaDevice("audioinput", "mic-1", "Microphone One"),
      ]);
    setMediaDevicesMock({
      enumerateDevices,
    });

    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        selectedVideoDeviceId: "stale-camera",
        selectedAudioDeviceId: "mic-1",
      });
    });

    await act(async () => {
      await recorder.latest.refreshDevices();
    });

    await waitFor(() => {
      expect(recorder.latest.settings.selectedVideoDeviceId).toBeNull();
      expect(recorder.latest.settings.selectedAudioDeviceId).toBe("mic-1");
    });
  });

  it("ignores device enumeration rejection after unmount without logging", async () => {
    setMediaRecorderSupport(["video/webm"]);
    let rejectEnumerate: ((reason?: unknown) => void) | null = null;
    const enumerateDevices = vi.fn(
      () =>
        new Promise<MediaDeviceInfo[]>((_, reject) => {
          rejectEnumerate = reject;
        }),
    );
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    setMediaDevicesMock({
      enumerateDevices,
    });

    const recorder = renderUseVideoRecorder();
    await waitFor(() => {
      expect(enumerateDevices).toHaveBeenCalledTimes(1);
    });

    act(() => {
      recorder.unmount();
    });

    await act(async () => {
      rejectEnumerate?.(new Error("enumerate failed after unmount"));
      await Promise.resolve();
    });

    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("recovers and allows restart when MediaRecorder initialization throws once", async () => {
    const videoTrackStop = vi.fn();
    const cancelAnimationFrameSpy = vi
      .spyOn(window, "cancelAnimationFrame")
      .mockImplementation(() => {});
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    setMediaDevicesMock({
      enumerateDevices: vi.fn(async () => []),
      getUserMedia: vi.fn(),
    });
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() =>
      createMockCanvasContext(),
    );
    Object.defineProperty(HTMLCanvasElement.prototype, "captureStream", {
      configurable: true,
      value: vi.fn(() => ({
        getVideoTracks: () =>
          [
            {
              kind: "video",
              stop: videoTrackStop,
            },
          ] as unknown as MediaStreamTrack[],
      })),
    });

    class MockMediaStream {
      private tracks: MediaStreamTrack[] = [];
      addTrack(track: MediaStreamTrack) {
        this.tracks.push(track);
      }
      getTracks() {
        return this.tracks;
      }
      getAudioTracks() {
        return this.tracks.filter((track) => track.kind === "audio");
      }
    }
    globalThis.MediaStream = MockMediaStream as any;

    let constructorCalls = 0;
    class ThrowingMediaRecorder {
      static isTypeSupported = (mimeType: string) => mimeType.includes("webm");
      state: RecordingState = "inactive";
      mimeType = "video/webm";
      ondataavailable: ((event: BlobEvent) => void) | null = null;
      onstop: (() => void) | null = null;
      onerror: ((event: any) => void) | null = null;
      private stopListeners = new Set<() => void>();
      constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
        constructorCalls += 1;
        if (constructorCalls === 1) {
          throw new Error("recorder init failed");
        }
        this.mimeType = options?.mimeType || "video/webm";
      }
      start() {
        this.state = "recording";
        this.ondataavailable?.({
          data: new Blob(["chunk"], { type: this.mimeType }),
        } as BlobEvent);
      }
      stop() {
        this.state = "inactive";
        this.stopListeners.forEach((listener) => listener());
        this.onstop?.();
      }
      addEventListener(event: "stop", listener: () => void) {
        if (event === "stop") {
          this.stopListeners.add(listener);
        }
      }
      removeEventListener(event: "stop", listener: () => void) {
        if (event === "stop") {
          this.stopListeners.delete(listener);
        }
      }
    }
    globalThis.MediaRecorder = ThrowingMediaRecorder as any;

    const { cleanup } = createExcalidrawCanvases();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe("recorder init failed");
    });
    expect(videoTrackStop).toHaveBeenCalledTimes(1);
    expect(cancelAnimationFrameSpy).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    expect(recorder.latest.isRecordingActive).toBe(false);

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
      expect(recorder.latest.error).toBeNull();
      expect(recorder.latest.settings.selectedVideoDeviceId).toBeNull();
    });

    await act(async () => {
      await recorder.latest.stopRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("completed");
      expect(recorder.latest.result).toBeTruthy();
    });

    expect(videoTrackStop).toHaveBeenCalledTimes(2);
    expect(cancelAnimationFrameSpy).toHaveBeenCalledTimes(2);
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);

    cleanup();
  });

  it("clears previous permission errors after a later successful request", async () => {
    setMediaRecorderSupport(["video/webm"]);
    const denied = new DOMException("", "NotAllowedError");
    const stopTrack = vi.fn();
    const permissionStream = {
      getTracks: () => [{ stop: stopTrack }],
    } as unknown as MediaStream;
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(denied)
      .mockResolvedValueOnce(permissionStream);
    const enumerateDevices = vi.fn(async () => []);
    setMediaDevicesMock({
      enumerateDevices,
      getUserMedia,
    });

    const recorder = renderUseVideoRecorder();

    await act(async () => {
      await recorder.latest.requestMediaPermissions();
    });
    await waitFor(() => {
      expect(recorder.latest.error).toBe(mapVideoRecorderErrorMessage(denied));
      expect(recorder.latest.isRequestingPermissions).toBe(false);
    });

    await act(async () => {
      await recorder.latest.requestMediaPermissions();
    });
    await waitFor(() => {
      expect(recorder.latest.error).toBeNull();
      expect(recorder.latest.isRequestingPermissions).toBe(false);
    });

    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(enumerateDevices).toHaveBeenCalledTimes(2);
  });

  it("sets error when starting recording without MediaRecorder support", async () => {
    delete (globalThis as any).MediaRecorder;
    setMediaDevicesMock({
      enumerateDevices: vi.fn(async () => []),
      getUserMedia: vi.fn(),
    });

    const recorder = renderUseVideoRecorder();

    await act(async () => {
      await recorder.latest.startRecording();
    });

    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "This browser does not support video recording.",
      );
    });
  });

  it("falls back to another supported mimeType when constructor rejects preferred mime", async () => {
    const setup = setupRecordingFlowMocks({
      supportedMimeTypes: ["video/mp4", "video/webm"],
      unsupportedConstructorMimeTypes: ["video/mp4"],
    });
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
        mimeType: "video/mp4",
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
      expect(recorder.latest.error).toBeNull();
      expect(recorder.latest.settings.mimeType).toBe("video/webm");
    });

    await act(async () => {
      await recorder.latest.stopRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("completed");
      expect(recorder.latest.result?.mimeType).toBe("video/webm");
    });

    setup.cleanupCanvases();
  });

  it("syncs settings to runtime mimeType when fallback constructor succeeds without mime option", async () => {
    const setup = setupRecordingFlowMocks({
      supportedMimeTypes: ["video/mp4"],
      unsupportedConstructorMimeTypes: ["video/mp4"],
      defaultConstructorMimeType: "video/webm",
    });
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
        mimeType: "video/mp4",
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
      expect(recorder.latest.error).toBeNull();
      expect(recorder.latest.settings.mimeType).toBe("video/webm");
    });

    await act(async () => {
      await recorder.latest.stopRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("completed");
      expect(recorder.latest.result?.mimeType).toBe("video/webm");
    });

    setup.cleanupCanvases();
  });

  it("records when mime probing is unavailable by falling back to constructor defaults", async () => {
    const setup = setupRecordingFlowMocks({
      omitIsTypeSupported: true,
      unsupportedConstructorMimeTypes: ["video/webm"],
      defaultConstructorMimeType: "video/mp4",
    });
    const recorder = renderUseVideoRecorder();

    expect(recorder.latest.settings.mimeType).toBe("video/webm");

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });
    expect(recorder.latest.settings.mimeType).toBe("video/webm");

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.capabilities.isSupported).toBe(true);
      expect(recorder.latest.capabilities.supportedMimeTypes).toEqual([]);
      expect(recorder.latest.status).toBe("recording");
      expect(recorder.latest.error).toBeNull();
      expect(recorder.latest.settings.mimeType).toBe("video/mp4");
    });

    await act(async () => {
      await recorder.latest.stopRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("completed");
      expect(recorder.latest.result?.mimeType).toBe("video/mp4");
    });

    setup.cleanupCanvases();
  });

  it("keeps trimmed requested mimeType when probing support list is unavailable", async () => {
    const setup = setupRecordingFlowMocks({
      omitIsTypeSupported: true,
    });
    const recorder = renderUseVideoRecorder();

    await waitFor(() => {
      expect(recorder.latest.settings.mimeType).toBe("video/webm");
    });

    act(() => {
      recorder.latest.setSettings({
        mimeType: " video/mp4 ",
      });
    });

    await waitFor(() => {
      expect(recorder.latest.settings.mimeType).toBe("video/mp4");
    });
    setup.cleanupCanvases();
  });

  it("falls back to normalized supported mimeType when raw mime option throws TypeError", async () => {
    const setup = setupRecordingFlowMocks({
      supportedMimeTypes: ["video/webm;codecs=vp9,opus", "video/webm"],
      typeErrorConstructorMimeTypes: [
        "video/webm;codecs=vp9,opus",
        "video / webm; codecs = opus, vp9",
      ],
    });
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
        mimeType: "video / webm; codecs = opus, vp9",
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
      expect(recorder.latest.error).toBeNull();
      expect(recorder.latest.settings.mimeType).toBe("video/webm");
    });

    await act(async () => {
      await recorder.latest.stopRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("completed");
      expect(recorder.latest.result?.mimeType).toBe("video/webm");
    });

    setup.cleanupCanvases();
  });

  it("does not treat non-mime TypeError as recoverable recorder mime mismatch", async () => {
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const setup = setupRecordingFlowMocks({
      supportedMimeTypes: ["video/webm;codecs=vp9,opus", "video/webm"],
      nonRecoverableTypeErrorConstructorMimeTypes: [
        "video/webm;codecs=vp9,opus",
      ],
    });
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
        mimeType: "video / webm; codecs = opus, vp9",
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "Cannot convert undefined or null to object",
      );
      expect(recorder.latest.result).toBeNull();
    });
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);

    setup.cleanupCanvases();
  });

  it("falls back when raw mime option throws non-dom not-supported error", async () => {
    const setup = setupRecordingFlowMocks({
      supportedMimeTypes: ["video/webm;codecs=vp9,opus", "video/webm"],
      namedNotSupportedConstructorMimeTypes: [
        "video/webm;codecs=vp9,opus",
        "video / webm; codecs = opus, vp9",
      ],
    });
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
        mimeType: "video / webm; codecs = opus, vp9",
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
      expect(recorder.latest.error).toBeNull();
      expect(recorder.latest.settings.mimeType).toBe("video/webm");
    });

    await act(async () => {
      await recorder.latest.stopRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("completed");
      expect(recorder.latest.result?.mimeType).toBe("video/webm");
    });

    setup.cleanupCanvases();
  });

  it("falls back when raw mime option only reports unsupported mime in message", async () => {
    const setup = setupRecordingFlowMocks({
      supportedMimeTypes: ["video/webm;codecs=vp9,opus", "video/webm"],
      messageNotSupportedConstructorMimeTypes: [
        "video/webm;codecs=vp9,opus",
        "video / webm; codecs = opus, vp9",
      ],
    });
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
        mimeType: "video / webm; codecs = opus, vp9",
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
      expect(recorder.latest.error).toBeNull();
      expect(recorder.latest.settings.mimeType).toBe("video/webm");
    });

    await act(async () => {
      await recorder.latest.stopRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("completed");
      expect(recorder.latest.result?.mimeType).toBe("video/webm");
    });

    setup.cleanupCanvases();
  });

  it("falls back when unsupported message references type without explicit mime keyword", async () => {
    const setup = setupRecordingFlowMocks({
      supportedMimeTypes: ["video/webm;codecs=vp9,opus", "video/webm"],
      messageNotSupportedConstructorMimeTypes: [
        "video/webm;codecs=vp9,opus",
        "video / webm; codecs = opus, vp9",
      ],
      messageNotSupportedConstructorErrorMessage:
        "Failed to construct 'MediaRecorder': The type provided is not supported.",
    });
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
        mimeType: "video / webm; codecs = opus, vp9",
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
      expect(recorder.latest.error).toBeNull();
      expect(recorder.latest.settings.mimeType).toBe("video/webm");
    });

    await act(async () => {
      await recorder.latest.stopRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("completed");
      expect(recorder.latest.result?.mimeType).toBe("video/webm");
    });

    setup.cleanupCanvases();
  });

  it("does not treat generic unsupported errors as recoverable mime mismatch", async () => {
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const setup = setupRecordingFlowMocks({
      supportedMimeTypes: ["video/webm;codecs=vp9,opus", "video/webm"],
      messageNotSupportedConstructorMimeTypes: [
        "video/webm;codecs=vp9,opus",
        "video / webm; codecs = opus, vp9",
      ],
      messageNotSupportedConstructorErrorMessage:
        "Operation is not supported in current context.",
    });
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
        mimeType: "video / webm; codecs = opus, vp9",
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });

    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "Operation is not supported in current context.",
      );
      expect(recorder.latest.result).toBeNull();
    });
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);

    setup.cleanupCanvases();
  });

  it("reports canvas capture errors when excalidraw canvases are missing", async () => {
    setMediaRecorderSupport(["video/webm"]);
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const getUserMedia = vi.fn();
    setMediaDevicesMock({
      enumerateDevices: vi.fn(async () => []),
      getUserMedia,
    });
    document
      .querySelectorAll(
        ".excalidraw canvas.static, .excalidraw canvas.interactive",
      )
      .forEach((node) => node.remove());

    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });

    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe("Unable to capture drawing canvas.");
    });
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("pauses and resumes recording state transitions", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
      expect(recorder.latest.isRecordingActive).toBe(true);
    });

    act(() => {
      recorder.latest.pauseRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("paused");
      expect(recorder.latest.isRecordingActive).toBe(true);
    });
    expect(setup.pauseSpy).toHaveBeenCalledTimes(1);

    act(() => {
      recorder.latest.resumeRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
      expect(recorder.latest.isRecordingActive).toBe(true);
    });
    expect(setup.resumeSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      await recorder.latest.stopRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("completed");
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("switches to error and cleans up when pause action throws", async () => {
    const setup = setupRecordingFlowMocks({ pauseThrows: true });
    const recorder = renderUseVideoRecorder();
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      recorder.latest.pauseRecording();
    });

    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe("pause failed");
      expect(recorder.latest.isRecordingActive).toBe(false);
    });
    expect(setup.videoTrackStop).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    expect(setup.pauseSpy).toHaveBeenCalledTimes(0);

    setup.cleanupCanvases();
  });

  it("switches to error and cleans up when resume action throws", async () => {
    const setup = setupRecordingFlowMocks({ resumeThrows: true });
    const recorder = renderUseVideoRecorder();
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      recorder.latest.pauseRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("paused");
    });
    expect(setup.pauseSpy).toHaveBeenCalledTimes(1);

    act(() => {
      recorder.latest.resumeRecording();
    });

    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe("resume failed");
      expect(recorder.latest.isRecordingActive).toBe(false);
    });
    expect(setup.videoTrackStop).toHaveBeenCalledTimes(1);
    expect(setup.resumeSpy).toHaveBeenCalledTimes(0);
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);

    setup.cleanupCanvases();
  });

  it("switches to error state when MediaRecorder emits runtime error", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    expect(recorder.latest.status).toBe("recording");

    act(() => {
      setup.emitRecorderError("runtime recorder failure");
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe("runtime recorder failure");
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("maps runtime busy-source message to device busy copy", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    expect(recorder.latest.status).toBe("recording");

    act(() => {
      setup.emitRecorderError(
        "Could not start audio source due to another process.",
      );
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "Camera or microphone is currently busy.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("maps string event payload runtime errors to busy-device copy", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    expect(recorder.latest.status).toBe("recording");

    act(() => {
      setup.emitRecorderErrorEvent(
        "Could not start audio source due to another process.",
      );
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "Camera or microphone is currently busy.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("maps string event payload in-use messages to busy-device copy", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    expect(recorder.latest.status).toBe("recording");

    act(() => {
      setup.emitRecorderErrorEvent(
        "Microphone is already in use by another application.",
      );
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "Camera or microphone is currently busy.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("maps string event payload resource-busy messages to busy-device copy", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    expect(recorder.latest.status).toBe("recording");

    act(() => {
      setup.emitRecorderErrorEvent(
        "Device or resource busy while opening media input.",
      );
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "Camera or microphone is currently busy.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("maps string event payload failed-allocation messages to busy-device copy", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    expect(recorder.latest.status).toBe("recording");

    act(() => {
      setup.emitRecorderErrorEvent(
        "NotReadableError: Failed to allocate videosource",
      );
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "Camera or microphone is currently busy.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("maps string event payload runtime errors to not-supported copy", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    expect(recorder.latest.status).toBe("recording");

    act(() => {
      setup.emitRecorderErrorEvent(
        "Failed to construct 'MediaRecorder': The type provided is not supported.",
      );
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "This browser does not support video recording.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("maps spaced media recorder unsupported messages to not-supported copy", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    expect(recorder.latest.status).toBe("recording");

    act(() => {
      setup.emitRecorderErrorEvent(
        "Failed to construct 'MediaRecorder': Media Recorder is not supported in this browser.",
      );
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "This browser does not support video recording.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("maps spaced media recorder unavailable messages to not-supported copy", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    expect(recorder.latest.status).toBe("recording");

    act(() => {
      setup.emitRecorderErrorEvent(
        "Media Recorder API is unavailable in this browser.",
      );
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "This browser does not support video recording.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("maps media recorder disabled messages to not-supported copy", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    expect(recorder.latest.status).toBe("recording");

    act(() => {
      setup.emitRecorderErrorEvent(
        "MediaRecorder is disabled in this browser build.",
      );
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "This browser does not support video recording.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("maps media recorder is-not-defined messages to not-supported copy", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    expect(recorder.latest.status).toBe("recording");

    act(() => {
      setup.emitRecorderErrorEvent(
        "ReferenceError: MediaRecorder is not defined",
      );
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "This browser does not support video recording.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("maps media recorder not-a-constructor messages to not-supported copy", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    expect(recorder.latest.status).toBe("recording");

    act(() => {
      setup.emitRecorderErrorEvent(
        "TypeError: MediaRecorder is not a constructor",
      );
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "This browser does not support video recording.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("maps not-supported error names embedded in string payloads", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    expect(recorder.latest.status).toBe("recording");

    act(() => {
      setup.emitRecorderErrorEvent("DOMException: NotSupportedError");
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "This browser does not support video recording.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("maps string event payload error names to semantic error copy", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    expect(recorder.latest.status).toBe("recording");

    act(() => {
      setup.emitRecorderErrorEvent("NotSupportedError");
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "This browser does not support video recording.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("maps string event payload error-name prefixes with extra details", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    expect(recorder.latest.status).toBe("recording");

    act(() => {
      setup.emitRecorderErrorEvent("NotSupportedError: codec mismatch");
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "This browser does not support video recording.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("maps embedded string event error names to semantic permission copy", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    expect(recorder.latest.status).toBe("recording");

    act(() => {
      setup.emitRecorderErrorEvent("DOMException: SecurityError");
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "Camera or microphone permission was denied.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("maps string event payload missing-device signals to device-not-found copy", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    expect(recorder.latest.status).toBe("recording");

    act(() => {
      setup.emitRecorderErrorEvent("No such device");
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "Selected camera or microphone is not available.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("maps string event payload could-not-find-device signals to device-not-found copy", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    expect(recorder.latest.status).toBe("recording");

    act(() => {
      setup.emitRecorderErrorEvent(
        "Could not find selected media input device.",
      );
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "Selected camera or microphone is not available.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("maps string event payload invalid-device-id signals to device-not-found copy", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    expect(recorder.latest.status).toBe("recording");

    act(() => {
      setup.emitRecorderErrorEvent("Device ID invalid for selected input.");
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "Selected camera or microphone is not available.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("maps string event payload unsatisfied-constraint signals to device-not-found copy", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    expect(recorder.latest.status).toBe("recording");

    act(() => {
      setup.emitRecorderErrorEvent(
        "Failed to satisfy constraints specified for selected device.",
      );
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "Selected camera or microphone is not available.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("maps string event payload could-not-satisfy-constraint signals to device-not-found copy", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    expect(recorder.latest.status).toBe("recording");

    act(() => {
      setup.emitRecorderErrorEvent(
        "Could not satisfy constraints for selected device.",
      );
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "Selected camera or microphone is not available.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("maps string event payload could-not-be-satisfied constraint signals to device-not-found copy", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    expect(recorder.latest.status).toBe("recording");

    act(() => {
      setup.emitRecorderErrorEvent(
        "Could not be satisfied constraints for selected device.",
      );
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "Selected camera or microphone is not available.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("maps string event payload runtime permission denied messages to permission copy", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    expect(recorder.latest.status).toBe("recording");

    act(() => {
      setup.emitRecorderErrorEvent(
        "Access denied while opening camera stream.",
      );
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "Camera or microphone permission was denied.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("maps string event payload request-not-allowed messages to permission copy", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    expect(recorder.latest.status).toBe("recording");

    act(() => {
      setup.emitRecorderErrorEvent(
        "The request is not allowed by the user agent or the platform in the current context.",
      );
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "Camera or microphone permission was denied.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("maps string event payload permissions-policy messages to permission copy", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    expect(recorder.latest.status).toBe("recording");

    act(() => {
      setup.emitRecorderErrorEvent(
        'Access to the feature "camera" is disallowed by permissions policy.',
      );
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "Camera or microphone permission was denied.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("maps string event payload secure-context messages to permission copy", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    expect(recorder.latest.status).toBe("recording");

    act(() => {
      setup.emitRecorderErrorEvent(
        "getUserMedia camera access requires a secure context.",
      );
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "Camera or microphone permission was denied.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("maps string event payload permission-dismissed messages to permission copy", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    expect(recorder.latest.status).toBe("recording");

    act(() => {
      setup.emitRecorderErrorEvent("Camera permission was dismissed by user.");
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "Camera or microphone permission was denied.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("maps string event payload blocked-permission messages to permission copy", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    expect(recorder.latest.status).toBe("recording");

    act(() => {
      setup.emitRecorderErrorEvent(
        "Microphone access has been blocked by browser settings.",
      );
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "Camera or microphone permission was denied.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("falls back to generic error text when recorder error has no message", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderError();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe("Recording failed. Please try again.");
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("maps recorder runtime errors by name when message is missing", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderError(new DOMException("", "NotSupportedError"));
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "This browser does not support video recording.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("falls back to MediaRecorder error event payload when event.error is missing", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderErrorEvent({ name: "NotSupportedError" });
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "This browser does not support video recording.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("falls back to MediaRecorder target.error when event.error is missing", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderErrorEvent({
        target: { error: { name: "NotSupportedError" } },
      });
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "This browser does not support video recording.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("falls back to MediaRecorder currentTarget.error when target.error is missing", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderErrorEvent({
        currentTarget: { error: { name: "NotSupportedError" } },
      });
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "This browser does not support video recording.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("falls back to MediaRecorder srcElement.error when modern event fields are missing", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderErrorEvent({
        srcElement: { error: { name: "NotSupportedError" } },
      });
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "This browser does not support video recording.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("falls back to MediaRecorder detail.error when standard event fields are missing", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderErrorEvent({
        detail: { error: { name: "NotSupportedError" } },
      });
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "This browser does not support video recording.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("falls back to MediaRecorder detail string payload when event error fields are missing", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderErrorEvent({
        detail: "No such device",
      });
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "Selected camera or microphone is not available.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("falls back to MediaRecorder details.error when standard event fields are missing", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderErrorEvent({
        details: { error: { name: "NotSupportedError" } },
      });
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "This browser does not support video recording.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("falls back to MediaRecorder details string payload when event error fields are missing", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderErrorEvent({
        details: "No such device",
      });
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "Selected camera or microphone is not available.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("falls back to MediaRecorder data.error when event detail and standard fields are missing", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderErrorEvent({
        data: { error: { name: "NotSupportedError" } },
      });
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "This browser does not support video recording.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("falls back to MediaRecorder data string payload when event error fields are missing", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderErrorEvent({
        data: "No such device",
      });
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "Selected camera or microphone is not available.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("falls back to MediaRecorder reason string payload when event error fields are missing", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderErrorEvent({
        reason: "No such device",
      });
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "Selected camera or microphone is not available.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("falls back to MediaRecorder reason object payload when event error fields are missing", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderErrorEvent({
        reason: { name: "NotSupportedError" },
      });
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "This browser does not support video recording.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("falls back to MediaRecorder payload.error when event error fields are missing", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderErrorEvent({
        payload: { error: { name: "NotSupportedError" } },
      });
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "This browser does not support video recording.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("falls back to MediaRecorder target.payload string payload when event error fields are missing", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderErrorEvent({
        target: { payload: "No such device" },
      });
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "Selected camera or microphone is not available.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("falls back to MediaRecorder target.detail.error when top-level detail is missing", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderErrorEvent({
        target: { detail: { error: { name: "NotSupportedError" } } },
      });
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "This browser does not support video recording.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("falls back to MediaRecorder target.details.error when top-level detail is missing", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderErrorEvent({
        target: { details: { error: { name: "NotSupportedError" } } },
      });
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "This browser does not support video recording.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("falls back to MediaRecorder currentTarget.data string payload when error fields are missing", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderErrorEvent({
        currentTarget: { data: "No such device" },
      });
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "Selected camera or microphone is not available.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("maps runtime wrapped event.error target.error payloads to semantic errors", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderErrorEvent({
        error: {
          target: { error: { name: "NotSupportedError" } },
        },
      });
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "This browser does not support video recording.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("maps runtime wrapped event.error currentTarget.data payloads to semantic errors", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderErrorEvent({
        error: {
          currentTarget: { data: "No such device" },
        },
      });
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "Selected camera or microphone is not available.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("maps runtime wrapped event.error composedPath payloads to semantic errors", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderErrorEvent({
        error: {
          composedPath: () => ["Error", "NotSupportedError"],
        },
      });
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "This browser does not support video recording.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("maps runtime wrapped event.error path payloads to semantic errors", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderErrorEvent({
        error: {
          path: ["Error", "No such device"],
        },
      });
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "Selected camera or microphone is not available.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("maps runtime wrapped event.error arrays to semantic errors", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderErrorEvent({
        error: ["Error", "NotSupportedError"],
      });
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "This browser does not support video recording.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("falls back to MediaRecorder target.errors arrays when direct error fields are missing", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderErrorEvent({
        target: { errors: ["Error", "No such device"] },
      });
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "Selected camera or microphone is not available.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("maps runtime wrapped event.error generic reason with semantic cause to semantic errors", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderErrorEvent({
        error: {
          reason: "Error",
          cause: { name: "NotSupportedError" },
        },
      });
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "This browser does not support video recording.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("maps runtime wrapped event.error generic path with semantic cause to semantic errors", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderErrorEvent({
        error: {
          path: ["Error"],
          cause: { name: "NotSupportedError" },
        },
      });
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "This browser does not support video recording.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("falls back to MediaRecorder target.reason.error when top-level reason is missing", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderErrorEvent({
        target: { reason: { error: { name: "NotSupportedError" } } },
      });
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "This browser does not support video recording.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("falls back to MediaRecorder target.cause.error when top-level cause is missing", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderErrorEvent({
        target: { cause: { error: { name: "NotSupportedError" } } },
      });
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "This browser does not support video recording.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("falls back to MediaRecorder currentTarget.cause string payload when error fields are missing", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderErrorEvent({
        currentTarget: { cause: "No such device" },
      });
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "Selected camera or microphone is not available.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("falls back to MediaRecorder description.error when top-level fields are missing", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderErrorEvent({
        description: { error: { name: "NotSupportedError" } },
      });
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "This browser does not support video recording.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("falls back to MediaRecorder target.description string payload when error fields are missing", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderErrorEvent({
        target: { description: "No such device" },
      });
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "Selected camera or microphone is not available.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("falls back to MediaRecorder message.error when top-level fields are missing", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderErrorEvent({
        message: { error: { name: "NotSupportedError" } },
      });
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "This browser does not support video recording.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("falls back to MediaRecorder target.message string payload when error fields are missing", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderErrorEvent({
        target: { message: "No such device" },
      });
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "Selected camera or microphone is not available.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("falls back to MediaRecorder msg.error when top-level fields are missing", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderErrorEvent({
        msg: { error: { name: "NotSupportedError" } },
      });
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "This browser does not support video recording.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("falls back to MediaRecorder target.msg string payload when error fields are missing", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderErrorEvent({
        target: { msg: "No such device" },
      });
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "Selected camera or microphone is not available.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("falls back to MediaRecorder info.error when top-level fields are missing", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderErrorEvent({
        info: { error: { name: "NotSupportedError" } },
      });
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "This browser does not support video recording.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("falls back to MediaRecorder target.info string payload when error fields are missing", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderErrorEvent({
        target: { info: "No such device" },
      });
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "Selected camera or microphone is not available.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("falls back to MediaRecorder errorMessage.error when top-level fields are missing", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderErrorEvent({
        errorMessage: { error: { name: "NotSupportedError" } },
      });
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "This browser does not support video recording.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("falls back to MediaRecorder target.errorMessage string payload when error fields are missing", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderErrorEvent({
        target: { errorMessage: "No such device" },
      });
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "Selected camera or microphone is not available.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("falls back to MediaRecorder errorDescription.error when top-level fields are missing", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderErrorEvent({
        errorDescription: { error: { name: "NotSupportedError" } },
      });
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "This browser does not support video recording.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("falls back to MediaRecorder target.errorDescription string payload when error fields are missing", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderErrorEvent({
        target: { errorDescription: "No such device" },
      });
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "Selected camera or microphone is not available.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("falls back to MediaRecorder errorReason.error when top-level fields are missing", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderErrorEvent({
        errorReason: { error: { name: "NotSupportedError" } },
      });
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "This browser does not support video recording.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("falls back to MediaRecorder target.errorReason string payload when error fields are missing", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderErrorEvent({
        target: { errorReason: "No such device" },
      });
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "Selected camera or microphone is not available.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("falls back to MediaRecorder currentTarget.reason string payload when error fields are missing", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderErrorEvent({
        currentTarget: { reason: "No such device" },
      });
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "Selected camera or microphone is not available.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("falls back to MediaRecorder nativeEvent.error when top-level fields are missing", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderErrorEvent({
        nativeEvent: { error: { name: "NotSupportedError" } },
      });
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "This browser does not support video recording.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("falls back to MediaRecorder nativeEvent.nativeEvent.error when first-level wrapper has no direct payload", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderErrorEvent({
        nativeEvent: {
          nativeEvent: { error: { name: "NotSupportedError" } },
        },
      });
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "This browser does not support video recording.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("falls back to MediaRecorder originalEvent reason payload when top-level fields are missing", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderErrorEvent({
        originalEvent: { reason: "No such device" },
      });
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "Selected camera or microphone is not available.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("falls back to MediaRecorder composedPath error payload when direct event fields are missing", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderErrorEvent({
        composedPath: () => [{ error: { name: "NotSupportedError" } }],
      });
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "This browser does not support video recording.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("falls back to MediaRecorder composedPath string payload when direct event fields are missing", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderErrorEvent({
        composedPath: () => ["No such device"],
      });
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "Selected camera or microphone is not available.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("prefers semantic MediaRecorder composedPath string entries over generic entries", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderErrorEvent({
        composedPath: () => ["Error", "No such device"],
      });
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "Selected camera or microphone is not available.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("falls back to MediaRecorder path error payload when direct event fields are missing", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderErrorEvent({
        path: [{ error: { name: "NotSupportedError" } }],
      });
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "This browser does not support video recording.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("falls back to MediaRecorder path string payload when direct event fields are missing", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderErrorEvent({
        path: ["No such device"],
      });
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "Selected camera or microphone is not available.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("prefers semantic MediaRecorder path string entries over generic entries", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderErrorEvent({
        path: ["Error", "NotSupportedError"],
      });
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "This browser does not support video recording.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("prefers semantic MediaRecorder composedPath entries over earlier non-semantic entries", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderErrorEvent({
        composedPath: () => [
          { foo: "bar" },
          { error: { name: "NotSupportedError" } },
        ],
      });
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "This browser does not support video recording.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("falls back to MediaRecorder nativeEvent.target.error when top-level fields are missing", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderErrorEvent({
        nativeEvent: {
          target: { error: { name: "NotSupportedError" } },
        },
      });
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "This browser does not support video recording.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("falls back to MediaRecorder originalEvent.currentTarget.data payload when top-level fields are missing", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderErrorEvent({
        originalEvent: {
          currentTarget: { data: "No such device" },
        },
      });
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "Selected camera or microphone is not available.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("falls back to MediaRecorder originalEvent.originalEvent currentTarget.data payload when wrappers are nested", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderErrorEvent({
        originalEvent: {
          originalEvent: { currentTarget: { data: "No such device" } },
        },
      });
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "Selected camera or microphone is not available.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("maps MediaRecorder nested cause names when runtime error payload wraps the root error", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderErrorEvent({
        error: {
          cause: { name: "NotSupportedError" },
        },
      });
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "This browser does not support video recording.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("maps MediaRecorder generic wrapper names by traversing to semantic nested causes", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderErrorEvent({
        error: {
          name: "Error",
          cause: { name: "NotSupportedError" },
        },
      });
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "This browser does not support video recording.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("maps MediaRecorder DOMException wrapper names by traversing to semantic nested causes", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderErrorEvent({
        error: {
          name: "DOMException",
          cause: { name: "NotSupportedError" },
        },
      });
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "This browser does not support video recording.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("maps MediaRecorder AggregateError wrapper names by traversing nested errors entries", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderErrorEvent({
        error: {
          name: "AggregateError",
          errors: [{ name: "NotSupportedError" }],
        },
      });
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "This browser does not support video recording.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("maps MediaRecorder AggregateError wrappers by skipping generic first errors entry", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderErrorEvent({
        error: {
          name: "AggregateError",
          errors: [{ name: "Error" }, { name: "NotSupportedError" }],
        },
      });
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "This browser does not support video recording.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("maps MediaRecorder AggregateError wrappers with string entries by skipping generic first entry", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderErrorEvent({
        error: {
          name: "AggregateError",
          errors: ["Error", "NotSupportedError"],
        },
      });
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "This browser does not support video recording.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("maps deeply nested generic wrappers by traversing multiple nested levels", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderErrorEvent({
        error: {
          name: "Error",
          cause: {
            name: "DOMException",
            cause: {
              name: "AggregateError",
              errors: [{ cause: { name: "NotSupportedError" } }],
            },
          },
        },
      });
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "This browser does not support video recording.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("maps MediaRecorder wrapper payloads with causes arrays to semantic errors", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderErrorEvent({
        error: {
          name: "AggregateError",
          causes: [{ name: "NotSupportedError" }],
        },
      });
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "This browser does not support video recording.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("maps MediaRecorder wrapper payloads with reasons arrays to semantic errors", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderErrorEvent({
        error: {
          reasons: ["No such device"],
        },
      });
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "Selected camera or microphone is not available.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("maps MediaRecorder wrapper payloads with err aliases to semantic errors", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderErrorEvent({
        error: {
          err: { name: "NotSupportedError" },
        },
      });
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "This browser does not support video recording.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("maps MediaRecorder wrapper payloads with exception aliases to semantic errors", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderErrorEvent({
        error: {
          exception: { message: "No such device" },
        },
      });
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "Selected camera or microphone is not available.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("maps MediaRecorder wrapper payloads with rootCause aliases to semantic errors", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderErrorEvent({
        error: {
          rootCause: { name: "NotSupportedError" },
        },
      });
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "This browser does not support video recording.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("maps MediaRecorder string cause payloads when runtime error wraps browser names", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderErrorEvent({
        error: {
          cause: "NotSupportedError",
        },
      });
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "This browser does not support video recording.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("maps MediaRecorder nested error wrappers when runtime payload uses error.error shape", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderErrorEvent({
        error: {
          error: {
            name: "NotSupportedError",
          },
        },
      });
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "This browser does not support video recording.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("maps MediaRecorder nested innerError wrappers when runtime payload uses error.innerError shape", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderErrorEvent({
        error: {
          innerError: {
            name: "NotSupportedError",
          },
        },
      });
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "This browser does not support video recording.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("maps MediaRecorder detail.reason payload when runtime event does not expose standard errors", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderErrorEvent({
        detail: { reason: "No such device" },
      });
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        "Selected camera or microphone is not available.",
      );
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("ignores duplicate start requests while recording", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    expect(setup.captureStreamSpy).toHaveBeenCalledTimes(1);
    expect(recorder.latest.status).toBe("recording");

    await act(async () => {
      await recorder.latest.stopRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("completed");
    });

    setup.cleanupCanvases();
  });

  it("falls back to default camera when selected camera device is unavailable on start", async () => {
    const setup = setupRecordingFlowMocks();
    const enumerateDevices = vi.fn(async () => []);
    const cameraTrackStop = vi.fn();
    const cameraStream = {
      getTracks: () => [{ stop: cameraTrackStop }],
    } as unknown as MediaStream;
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(new DOMException("", "NotFoundError"))
      .mockResolvedValueOnce(cameraStream);
    setMediaDevicesMock({
      enumerateDevices,
      getUserMedia,
    });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});

    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: true,
        microphoneEnabled: false,
        selectedVideoDeviceId: "missing-camera",
        selectedAudioDeviceId: "keep-mic",
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
      expect(recorder.latest.error).toBeNull();
      expect(recorder.latest.settings.selectedAudioDeviceId).toBe("keep-mic");
    });

    expect(getUserMedia).toHaveBeenNthCalledWith(1, {
      video: { deviceId: { exact: "missing-camera" } },
      audio: false,
    });
    expect(getUserMedia).toHaveBeenNthCalledWith(2, {
      video: true,
      audio: false,
    });

    await act(async () => {
      await recorder.latest.stopRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("completed");
    });
    expect(cameraTrackStop).toHaveBeenCalledTimes(1);

    setup.cleanupCanvases();
  });

  it("falls back to default camera when start error message indicates missing selected input", async () => {
    const setup = setupRecordingFlowMocks();
    const enumerateDevices = vi.fn(async () => []);
    const cameraTrackStop = vi.fn();
    const cameraStream = {
      getTracks: () => [{ stop: cameraTrackStop }],
    } as unknown as MediaStream;
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("Requested device not found for selected input."),
      )
      .mockResolvedValueOnce(cameraStream);
    setMediaDevicesMock({
      enumerateDevices,
      getUserMedia,
    });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});

    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: true,
        microphoneEnabled: false,
        selectedVideoDeviceId: "missing-camera",
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
      expect(recorder.latest.error).toBeNull();
      expect(recorder.latest.settings.selectedVideoDeviceId).toBeNull();
    });

    expect(getUserMedia).toHaveBeenNthCalledWith(1, {
      video: { deviceId: { exact: "missing-camera" } },
      audio: false,
    });
    expect(getUserMedia).toHaveBeenNthCalledWith(2, {
      video: true,
      audio: false,
    });

    await act(async () => {
      await recorder.latest.stopRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("completed");
    });
    expect(cameraTrackStop).toHaveBeenCalledTimes(1);

    setup.cleanupCanvases();
  });

  it("does not retry start recording on non-selection media errors", async () => {
    const setup = setupRecordingFlowMocks();
    const enumerateDevices = vi.fn(async () => []);
    const denied = new DOMException("", "NotAllowedError");
    const getUserMedia = vi.fn().mockRejectedValue(denied);
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    setMediaDevicesMock({
      enumerateDevices,
      getUserMedia,
    });

    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: true,
        microphoneEnabled: false,
        selectedVideoDeviceId: "camera-1",
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });

    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(mapVideoRecorderErrorMessage(denied));
      expect(recorder.latest.settings.selectedVideoDeviceId).toBe("camera-1");
    });
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(getUserMedia).toHaveBeenCalledWith({
      video: { deviceId: { exact: "camera-1" } },
      audio: false,
    });
    expect(enumerateDevices).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);

    setup.cleanupCanvases();
  });

  it("refreshes devices after start fails with device-selection errors", async () => {
    const setup = setupRecordingFlowMocks();
    const enumerateDevices = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        createMockMediaDevice("videoinput", "camera-1", "Camera One"),
      ]);
    const notFound = new DOMException("", "NotFoundError");
    const getUserMedia = vi.fn().mockRejectedValue(notFound);
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    setMediaDevicesMock({
      enumerateDevices,
      getUserMedia,
    });

    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: true,
        microphoneEnabled: false,
        selectedVideoDeviceId: "stale-camera",
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });

    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        mapVideoRecorderErrorMessage(notFound),
      );
      expect(recorder.latest.settings.selectedVideoDeviceId).toBeNull();
      expect(recorder.latest.devices).toEqual({
        videoInputs: [{ deviceId: "camera-1", label: "Camera One" }],
        audioInputs: [],
      });
    });
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(getUserMedia).toHaveBeenNthCalledWith(1, {
      video: { deviceId: { exact: "stale-camera" } },
      audio: false,
    });
    expect(getUserMedia).toHaveBeenNthCalledWith(2, {
      video: true,
      audio: false,
    });
    expect(enumerateDevices).toHaveBeenCalledTimes(2);
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);

    setup.cleanupCanvases();
  });

  it("allows retrying start while refresh reconciliation is pending", async () => {
    const setup = setupRecordingFlowMocks();
    const pendingRefreshResolvers: Array<(value: MediaDeviceInfo[]) => void> =
      [];
    const enumerateDevices = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockImplementation(
        () =>
          new Promise<MediaDeviceInfo[]>((resolve) => {
            pendingRefreshResolvers.push(resolve);
          }),
      );
    const notFound = new DOMException("", "NotFoundError");
    const getUserMedia = vi.fn().mockRejectedValue(notFound);
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    setMediaDevicesMock({
      enumerateDevices,
      getUserMedia,
    });

    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: true,
        microphoneEnabled: false,
        selectedVideoDeviceId: "stale-camera",
      });
    });

    act(() => {
      void recorder.latest.startRecording();
    });

    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        mapVideoRecorderErrorMessage(notFound),
      );
    });
    expect(getUserMedia).toHaveBeenCalledTimes(2);

    act(() => {
      void recorder.latest.startRecording();
    });

    await waitFor(() => {
      expect(getUserMedia).toHaveBeenCalledTimes(3);
      expect(recorder.latest.status).toBe("error");
    });
    expect(getUserMedia).toHaveBeenNthCalledWith(3, {
      video: true,
      audio: false,
    });
    expect(consoleErrorSpy).toHaveBeenCalledTimes(2);

    pendingRefreshResolvers.forEach((resolve) => resolve([]));
    await act(async () => {
      await Promise.resolve();
    });

    setup.cleanupCanvases();
  });

  it("clears stale selected camera when start fallback also fails", async () => {
    const setup = setupRecordingFlowMocks();
    const enumerateDevices = vi.fn(async () => []);
    const notFound = new DOMException("", "NotFoundError");
    const getUserMedia = vi.fn().mockRejectedValue(notFound);
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    setMediaDevicesMock({
      enumerateDevices,
      getUserMedia,
    });

    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: true,
        microphoneEnabled: false,
        selectedVideoDeviceId: "stale-camera",
        selectedAudioDeviceId: "keep-mic",
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });

    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        mapVideoRecorderErrorMessage(notFound),
      );
      expect(recorder.latest.settings.selectedVideoDeviceId).toBeNull();
      expect(recorder.latest.settings.selectedAudioDeviceId).toBe("keep-mic");
    });
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(getUserMedia).toHaveBeenNthCalledWith(1, {
      video: { deviceId: { exact: "stale-camera" } },
      audio: false,
    });
    expect(getUserMedia).toHaveBeenNthCalledWith(2, {
      video: true,
      audio: false,
    });
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);

    setup.cleanupCanvases();
  });

  it("clears stale selected microphone when start fallback also fails", async () => {
    const setup = setupRecordingFlowMocks();
    const enumerateDevices = vi.fn(async () => []);
    const notFound = new DOMException("", "NotFoundError");
    const getUserMedia = vi.fn().mockRejectedValue(notFound);
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    setMediaDevicesMock({
      enumerateDevices,
      getUserMedia,
    });

    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: true,
        selectedAudioDeviceId: "stale-mic",
        selectedVideoDeviceId: "keep-camera",
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });

    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        mapVideoRecorderErrorMessage(notFound),
      );
      expect(recorder.latest.settings.selectedAudioDeviceId).toBeNull();
      expect(recorder.latest.settings.selectedVideoDeviceId).toBe(
        "keep-camera",
      );
    });
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(getUserMedia).toHaveBeenNthCalledWith(1, {
      audio: { deviceId: { exact: "stale-mic" } },
      video: false,
    });
    expect(getUserMedia).toHaveBeenNthCalledWith(2, {
      audio: true,
      video: false,
    });
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);

    setup.cleanupCanvases();
  });

  it("cleans up acquired camera stream before pending refresh on start fallback failure", async () => {
    const setup = setupRecordingFlowMocks();
    let resolveRefreshDevices: ((value: MediaDeviceInfo[]) => void) | null =
      null;
    const enumerateDevices = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockImplementationOnce(
        () =>
          new Promise<MediaDeviceInfo[]>((resolve) => {
            resolveRefreshDevices = resolve;
          }),
      );
    const notFound = new DOMException("", "NotFoundError");
    const cameraTrackStop = vi.fn();
    const cameraStream = {
      getTracks: () => [{ kind: "video", stop: cameraTrackStop }],
    } as unknown as MediaStream;
    const getUserMedia = vi
      .fn()
      .mockResolvedValueOnce(cameraStream)
      .mockRejectedValueOnce(notFound)
      .mockRejectedValueOnce(notFound);
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    setMediaDevicesMock({
      enumerateDevices,
      getUserMedia,
    });

    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: true,
        microphoneEnabled: true,
        selectedAudioDeviceId: "stale-mic",
      });
    });

    let startPromise: Promise<void> | null = null;
    act(() => {
      startPromise = recorder.latest.startRecording();
    });

    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe(
        mapVideoRecorderErrorMessage(notFound),
      );
    });
    expect(cameraTrackStop).toHaveBeenCalledTimes(1);
    expect(enumerateDevices).toHaveBeenCalledTimes(2);
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveRefreshDevices?.([
        createMockMediaDevice("videoinput", "camera-1", "Camera One"),
      ]);
      await startPromise;
    });

    setup.cleanupCanvases();
  });

  it("does not clear a newly selected camera if start fallback resolves later", async () => {
    const setup = setupRecordingFlowMocks();
    const enumerateDevices = vi.fn(async () => []);
    const cameraTrackStop = vi.fn();
    const cameraStream = {
      getTracks: () => [{ stop: cameraTrackStop }],
    } as unknown as MediaStream;
    let resolveFallbackRequest: ((value: MediaStream) => void) | null = null;
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(new DOMException("", "NotFoundError"))
      .mockImplementationOnce(
        () =>
          new Promise<MediaStream>((resolve) => {
            resolveFallbackRequest = resolve;
          }),
      );
    setMediaDevicesMock({
      enumerateDevices,
      getUserMedia,
    });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});

    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: true,
        microphoneEnabled: false,
        selectedVideoDeviceId: "stale-camera",
      });
    });

    act(() => {
      void recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(getUserMedia).toHaveBeenCalledTimes(2);
    });

    act(() => {
      recorder.latest.setSettings({
        selectedVideoDeviceId: "new-camera",
      });
    });

    await act(async () => {
      resolveFallbackRequest?.(cameraStream);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
      expect(recorder.latest.error).toBeNull();
      expect(recorder.latest.settings.selectedVideoDeviceId).toBe("new-camera");
    });

    await act(async () => {
      await recorder.latest.stopRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("completed");
    });
    expect(cameraTrackStop).toHaveBeenCalledTimes(1);

    setup.cleanupCanvases();
  });

  it("preserves selected camera when camera gets disabled before start fallback resolves", async () => {
    const setup = setupRecordingFlowMocks();
    const enumerateDevices = vi.fn(async () => []);
    const cameraTrackStop = vi.fn();
    const cameraStream = {
      getTracks: () => [{ stop: cameraTrackStop }],
    } as unknown as MediaStream;
    let rejectPrimaryRequest: ((reason?: unknown) => void) | null = null;
    const getUserMedia = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<MediaStream>((_resolve, reject) => {
            rejectPrimaryRequest = reject;
          }),
      )
      .mockResolvedValueOnce(cameraStream);
    setMediaDevicesMock({
      enumerateDevices,
      getUserMedia,
    });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});

    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: true,
        microphoneEnabled: false,
        selectedVideoDeviceId: "stale-camera",
      });
    });

    act(() => {
      void recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("preparing");
      expect(getUserMedia).toHaveBeenCalledTimes(1);
    });

    act(() => {
      recorder.latest.setSettings({ cameraEnabled: false });
    });

    await act(async () => {
      rejectPrimaryRequest?.(new DOMException("", "NotFoundError"));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(getUserMedia).toHaveBeenCalledTimes(2);
      expect(recorder.latest.status).toBe("recording");
      expect(recorder.latest.error).toBeNull();
      expect(recorder.latest.settings.selectedVideoDeviceId).toBe(
        "stale-camera",
      );
    });

    await act(async () => {
      await recorder.latest.stopRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("completed");
    });
    expect(cameraTrackStop).toHaveBeenCalledTimes(1);

    setup.cleanupCanvases();
  });

  it("preserves selected microphone when microphone gets disabled before start fallback resolves", async () => {
    const setup = setupRecordingFlowMocks();
    const enumerateDevices = vi.fn(async () => []);
    const microphoneTrackStop = vi.fn();
    const microphoneTrack = {
      kind: "audio",
      stop: microphoneTrackStop,
    } as unknown as MediaStreamTrack;
    const microphoneStream = {
      getTracks: () => [microphoneTrack],
      getAudioTracks: () => [microphoneTrack],
    } as unknown as MediaStream;
    let rejectPrimaryRequest: ((reason?: unknown) => void) | null = null;
    const getUserMedia = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<MediaStream>((_resolve, reject) => {
            rejectPrimaryRequest = reject;
          }),
      )
      .mockResolvedValueOnce(microphoneStream);
    setMediaDevicesMock({
      enumerateDevices,
      getUserMedia,
    });

    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: true,
        selectedAudioDeviceId: "stale-mic",
      });
    });

    act(() => {
      void recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("preparing");
      expect(getUserMedia).toHaveBeenCalledTimes(1);
    });

    act(() => {
      recorder.latest.setSettings({ microphoneEnabled: false });
    });

    await act(async () => {
      rejectPrimaryRequest?.(new DOMException("", "NotFoundError"));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(getUserMedia).toHaveBeenCalledTimes(2);
      expect(recorder.latest.status).toBe("recording");
      expect(recorder.latest.error).toBeNull();
      expect(recorder.latest.settings.selectedAudioDeviceId).toBe("stale-mic");
    });

    await act(async () => {
      await recorder.latest.stopRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("completed");
    });
    expect(microphoneTrackStop).toHaveBeenCalledTimes(1);

    setup.cleanupCanvases();
  });

  it("does not clear a newly selected microphone if start fallback resolves later", async () => {
    const setup = setupRecordingFlowMocks();
    const enumerateDevices = vi.fn(async () => []);
    const microphoneTrackStop = vi.fn();
    const microphoneTrack = {
      kind: "audio",
      stop: microphoneTrackStop,
    } as unknown as MediaStreamTrack;
    const microphoneStream = {
      getTracks: () => [microphoneTrack],
      getAudioTracks: () => [microphoneTrack],
    } as unknown as MediaStream;
    let resolveFallbackRequest: ((value: MediaStream) => void) | null = null;
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(new DOMException("", "NotFoundError"))
      .mockImplementationOnce(
        () =>
          new Promise<MediaStream>((resolve) => {
            resolveFallbackRequest = resolve;
          }),
      );
    setMediaDevicesMock({
      enumerateDevices,
      getUserMedia,
    });

    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: true,
        selectedAudioDeviceId: "stale-mic",
      });
    });

    act(() => {
      void recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(getUserMedia).toHaveBeenCalledTimes(2);
    });

    act(() => {
      recorder.latest.setSettings({
        selectedAudioDeviceId: "new-mic",
      });
    });

    await act(async () => {
      resolveFallbackRequest?.(microphoneStream);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
      expect(recorder.latest.error).toBeNull();
      expect(recorder.latest.settings.selectedAudioDeviceId).toBe("new-mic");
    });

    await act(async () => {
      await recorder.latest.stopRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("completed");
    });
    expect(microphoneTrackStop).toHaveBeenCalledTimes(1);

    setup.cleanupCanvases();
  });

  it("falls back to default microphone when selected microphone device is unavailable on start", async () => {
    const setup = setupRecordingFlowMocks();
    const enumerateDevices = vi.fn(async () => []);
    const microphoneTrackStop = vi.fn();
    const microphoneTrack = {
      kind: "audio",
      stop: microphoneTrackStop,
    } as unknown as MediaStreamTrack;
    const microphoneStream = {
      getTracks: () => [microphoneTrack],
      getAudioTracks: () => [microphoneTrack],
    } as unknown as MediaStream;
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(new DOMException("", "NotFoundError"))
      .mockResolvedValueOnce(microphoneStream);
    setMediaDevicesMock({
      enumerateDevices,
      getUserMedia,
    });

    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: true,
        selectedAudioDeviceId: "missing-mic",
        selectedVideoDeviceId: "keep-camera",
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
      expect(recorder.latest.error).toBeNull();
      expect(recorder.latest.settings.selectedVideoDeviceId).toBe(
        "keep-camera",
      );
    });

    expect(getUserMedia).toHaveBeenNthCalledWith(1, {
      audio: { deviceId: { exact: "missing-mic" } },
      video: false,
    });
    expect(getUserMedia).toHaveBeenNthCalledWith(2, {
      audio: true,
      video: false,
    });

    await act(async () => {
      await recorder.latest.stopRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("completed");
    });
    expect(microphoneTrackStop).toHaveBeenCalledTimes(1);

    setup.cleanupCanvases();
  });

  it("ignores duplicate start requests in the same tick before preparing state flushes", async () => {
    setMediaRecorderSupport(["video/webm"]);
    const { cleanup } = createExcalidrawCanvases();
    const enumerateDevices = vi.fn(async () => []);
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    let rejectPermission: ((reason?: unknown) => void) | null = null;
    const getUserMedia = vi.fn(
      () =>
        new Promise<MediaStream>((_resolve, reject) => {
          rejectPermission = reject;
        }),
    );

    setMediaDevicesMock({
      enumerateDevices,
      getUserMedia,
    });

    const recorder = renderUseVideoRecorder();
    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: true,
        microphoneEnabled: false,
      });
    });

    act(() => {
      void recorder.latest.startRecording();
      void recorder.latest.startRecording();
    });

    expect(getUserMedia).toHaveBeenCalledTimes(1);

    await waitFor(() => {
      expect(recorder.latest.status).toBe("preparing");
    });

    await act(async () => {
      rejectPermission?.(new DOMException("", "NotAllowedError"));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
    });
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    expect(enumerateDevices).toHaveBeenCalledTimes(1);

    cleanup();
  });

  it("ignores start requests while paused", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      recorder.latest.pauseRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("paused");
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    expect(setup.captureStreamSpy).toHaveBeenCalledTimes(1);
    expect(recorder.latest.status).toBe("paused");

    await act(async () => {
      await recorder.latest.stopRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("completed");
    });

    setup.cleanupCanvases();
  });

  it("ignores duplicate start requests while preparing", async () => {
    setMediaRecorderSupport(["video/webm"]);
    const { cleanup } = createExcalidrawCanvases();
    const enumerateDevices = vi.fn(async () => []);
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    let rejectPermission: ((reason?: unknown) => void) | null = null;
    const getUserMedia = vi.fn(
      () =>
        new Promise<MediaStream>((_resolve, reject) => {
          rejectPermission = reject;
        }),
    );

    setMediaDevicesMock({
      enumerateDevices,
      getUserMedia,
    });

    const recorder = renderUseVideoRecorder();
    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: true,
        microphoneEnabled: false,
      });
    });

    act(() => {
      void recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("preparing");
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    expect(getUserMedia).toHaveBeenCalledTimes(1);

    await act(async () => {
      rejectPermission?.(new DOMException("", "NotAllowedError"));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
    });
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    expect(enumerateDevices).toHaveBeenCalledTimes(1);

    cleanup();
  });

  it("cancels pending start flow on unmount and cleans acquired stream", async () => {
    setMediaRecorderSupport(["video/webm"]);
    const { cleanup } = createExcalidrawCanvases();
    const enumerateDevices = vi.fn(async () => []);
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const cameraTrackStop = vi.fn();
    const cameraStream = {
      getTracks: () => [{ stop: cameraTrackStop }],
    } as unknown as MediaStream;
    let resolveCameraRequest: ((value: MediaStream) => void) | null = null;
    const getUserMedia = vi.fn(
      () =>
        new Promise<MediaStream>((resolve) => {
          resolveCameraRequest = resolve;
        }),
    );

    setMediaDevicesMock({
      enumerateDevices,
      getUserMedia,
    });

    const recorder = renderUseVideoRecorder();
    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: true,
        microphoneEnabled: false,
      });
    });

    act(() => {
      void recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("preparing");
    });

    act(() => {
      recorder.unmount();
    });
    await act(async () => {
      resolveCameraRequest?.(cameraStream);
      await Promise.resolve();
    });

    expect(cameraTrackStop).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(enumerateDevices).toHaveBeenCalledTimes(1);

    cleanup();
  });

  it("ignores start permission rejection after unmount without logging", async () => {
    setMediaRecorderSupport(["video/webm"]);
    const { cleanup } = createExcalidrawCanvases();
    const enumerateDevices = vi.fn(async () => []);
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    let rejectCameraRequest: ((reason?: unknown) => void) | null = null;
    const getUserMedia = vi.fn(
      () =>
        new Promise<MediaStream>((_resolve, reject) => {
          rejectCameraRequest = reject;
        }),
    );

    setMediaDevicesMock({
      enumerateDevices,
      getUserMedia,
    });

    const recorder = renderUseVideoRecorder();
    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: true,
        microphoneEnabled: false,
      });
    });

    act(() => {
      void recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("preparing");
    });

    act(() => {
      recorder.unmount();
    });
    await act(async () => {
      rejectCameraRequest?.(new DOMException("", "NotAllowedError"));
      await Promise.resolve();
    });

    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(enumerateDevices).toHaveBeenCalledTimes(1);

    cleanup();
  });

  it("prevents duplicate stop calls while stopping", async () => {
    const setup = setupRecordingFlowMocks({ deferStop: true });
    const recorder = renderUseVideoRecorder();
    let firstStopPromise: Promise<void> | null = null;

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      firstStopPromise = recorder.latest.stopRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("stopping");
    });

    await act(async () => {
      await recorder.latest.stopRecording();
    });
    expect(setup.getStopCallCount()).toBe(1);

    await act(async () => {
      setup.flushStop();
      await firstStopPromise;
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("completed");
    });

    setup.cleanupCanvases();
  });

  it("ignores duplicate stop requests in the same tick before stopping state flushes", async () => {
    const setup = setupRecordingFlowMocks({ deferStop: true });
    const recorder = renderUseVideoRecorder();
    let firstStopPromise: Promise<void> | null = null;
    let secondStopPromise: Promise<void> | null = null;

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      firstStopPromise = recorder.latest.stopRecording();
      secondStopPromise = recorder.latest.stopRecording();
    });
    expect(setup.getStopCallCount()).toBe(1);

    await act(async () => {
      setup.flushStop();
      await Promise.all([firstStopPromise, secondStopPromise]);
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("completed");
    });

    setup.cleanupCanvases();
  });

  it("switches to error state when recorder stop throws", async () => {
    const setup = setupRecordingFlowMocks({ stopThrows: true });
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    await act(async () => {
      await recorder.latest.stopRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe("stop failed");
      expect(recorder.latest.isRecordingActive).toBe(false);
    });
    expect(setup.getStopCallCount()).toBe(1);
    expect(setup.videoTrackStop).toHaveBeenCalledTimes(1);

    setup.cleanupCanvases();
  });

  it("falls back to error when recorder stop event never fires", async () => {
    vi.useFakeTimers();
    const setup = setupRecordingFlowMocks({ deferStop: true });
    const recorder = renderUseVideoRecorder();
    let stopPromise: Promise<void> | null = null;

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      stopPromise = recorder.latest.stopRecording();
    });
    expect(recorder.latest.status).toBe("stopping");

    await act(async () => {
      vi.advanceTimersByTime(3000);
      await stopPromise;
    });
    expect(recorder.latest.status).toBe("error");
    expect(recorder.latest.error).toBe("Recording failed. Please try again.");
    expect(recorder.latest.isRecordingActive).toBe(false);
    expect(setup.getStopCallCount()).toBe(1);
    expect(setup.videoTrackStop).toHaveBeenCalledTimes(1);

    setup.cleanupCanvases();
  });

  it("does not overwrite recorder error with stop-timeout fallback", async () => {
    vi.useFakeTimers();
    const setup = setupRecordingFlowMocks({ deferStop: true });
    const recorder = renderUseVideoRecorder();
    let stopPromise: Promise<void> | null = null;

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    expect(recorder.latest.status).toBe("recording");

    act(() => {
      stopPromise = recorder.latest.stopRecording();
    });
    expect(recorder.latest.status).toBe("stopping");

    act(() => {
      setup.emitRecorderError("fatal recorder error");
    });
    expect(recorder.latest.status).toBe("error");
    expect(recorder.latest.error).toBe("fatal recorder error");

    await act(async () => {
      vi.advanceTimersByTime(3000);
      await stopPromise;
    });
    expect(recorder.latest.status).toBe("error");
    expect(recorder.latest.error).toBe("fatal recorder error");
    expect(recorder.latest.isRecordingActive).toBe(false);
    expect(setup.videoTrackStop).toHaveBeenCalledTimes(1);

    setup.cleanupCanvases();
  });

  it("resolves pending stop promise immediately when recorder errors while stopping", async () => {
    const setup = setupRecordingFlowMocks({ deferStop: true });
    const recorder = renderUseVideoRecorder();
    let stopPromise: Promise<void> = Promise.resolve();
    let didResolve = false;

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    expect(recorder.latest.status).toBe("recording");

    act(() => {
      stopPromise = recorder.latest.stopRecording();
      void stopPromise.then(() => {
        didResolve = true;
      });
    });
    expect(recorder.latest.status).toBe("stopping");

    act(() => {
      setup.emitRecorderError("fatal recorder error");
    });

    await waitFor(() => {
      expect(didResolve).toBe(true);
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe("fatal recorder error");
      expect(recorder.latest.isRecordingActive).toBe(false);
    });

    setup.cleanupCanvases();
  });

  it("resolves pending stop promise when hook unmounts during stopping", async () => {
    const setup = setupRecordingFlowMocks({ deferStop: true });
    const recorder = renderUseVideoRecorder();
    let stopPromise: Promise<void> = Promise.resolve();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    expect(recorder.latest.status).toBe("recording");

    act(() => {
      stopPromise = recorder.latest.stopRecording();
    });
    expect(recorder.latest.status).toBe("stopping");

    await act(async () => {
      recorder.unmount();
      await stopPromise;
    });
    expect(setup.getStopCallCount()).toBe(1);
    expect(setup.videoTrackStop).toHaveBeenCalledTimes(1);

    setup.cleanupCanvases();
  });

  it("detaches recorder callbacks on unmount", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    expect(recorder.latest.status).toBe("recording");
    expect(setup.getRecorderHandlers()).toMatchObject({
      ondataavailable: expect.any(Function),
      onerror: expect.any(Function),
      onstop: expect.any(Function),
    });

    act(() => {
      recorder.unmount();
    });

    expect(setup.getRecorderHandlers()).toEqual({
      ondataavailable: null,
      onerror: null,
      onstop: null,
    });

    setup.cleanupCanvases();
  });

  it("detaches recorder callbacks after successful stop", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    expect(setup.getRecorderHandlers()).toMatchObject({
      ondataavailable: expect.any(Function),
      onerror: expect.any(Function),
      onstop: expect.any(Function),
    });

    await act(async () => {
      await recorder.latest.stopRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("completed");
    });

    expect(setup.getRecorderHandlers()).toEqual({
      ondataavailable: null,
      onerror: null,
      onstop: null,
    });

    setup.cleanupCanvases();
  });

  it("detaches recorder callbacks after runtime error cleanup", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    expect(setup.getRecorderHandlers()).toMatchObject({
      ondataavailable: expect.any(Function),
      onerror: expect.any(Function),
      onstop: expect.any(Function),
    });

    act(() => {
      setup.emitRecorderError("fatal recorder error");
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe("fatal recorder error");
    });

    expect(setup.getRecorderHandlers()).toEqual({
      ondataavailable: null,
      onerror: null,
      onstop: null,
    });

    setup.cleanupCanvases();
  });

  it("keeps completed state after successful stop even past timeout window", async () => {
    vi.useFakeTimers();
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    expect(recorder.latest.status).toBe("recording");

    await act(async () => {
      await recorder.latest.stopRecording();
    });
    expect(recorder.latest.status).toBe("completed");
    expect(recorder.latest.error).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(3000);
      await Promise.resolve();
    });
    expect(recorder.latest.status).toBe("completed");
    expect(recorder.latest.error).toBeNull();
    expect(setup.videoTrackStop).toHaveBeenCalledTimes(1);

    setup.cleanupCanvases();
  });

  it("ignores start requests while stopping", async () => {
    const setup = setupRecordingFlowMocks({ deferStop: true });
    const recorder = renderUseVideoRecorder();
    let firstStopPromise: Promise<void> | null = null;

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      firstStopPromise = recorder.latest.stopRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("stopping");
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    expect(setup.captureStreamSpy).toHaveBeenCalledTimes(1);
    expect(recorder.latest.status).toBe("stopping");

    await act(async () => {
      setup.flushStop();
      await firstStopPromise;
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("completed");
    });

    setup.cleanupCanvases();
  });

  it("auto-pauses recording when page becomes hidden", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    act(() => {
      document.dispatchEvent(new Event(EVENT.VISIBILITY_CHANGE));
    });

    await waitFor(() => {
      expect(recorder.latest.status).toBe("paused");
      expect(recorder.latest.isRecordingActive).toBe(true);
    });
    expect(setup.pauseSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      await recorder.latest.stopRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("completed");
    });

    setup.cleanupCanvases();
  });

  it("switches to error when visibility auto-pause throws", async () => {
    const setup = setupRecordingFlowMocks({ pauseThrows: true });
    const recorder = renderUseVideoRecorder();
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    act(() => {
      document.dispatchEvent(new Event(EVENT.VISIBILITY_CHANGE));
    });

    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe("pause failed");
      expect(recorder.latest.isRecordingActive).toBe(false);
    });
    expect(setup.videoTrackStop).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    expect(setup.pauseSpy).toHaveBeenCalledTimes(0);

    setup.cleanupCanvases();
  });

  it("freezes elapsed time when auto-paused by page visibility change", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    await act(async () => {
      vi.advanceTimersByTime(1_200);
    });
    const elapsedBeforeHidden = recorder.latest.elapsedMs;
    expect(elapsedBeforeHidden).toBeGreaterThanOrEqual(1_000);

    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    act(() => {
      document.dispatchEvent(new Event(EVENT.VISIBILITY_CHANGE));
    });

    await waitFor(() => {
      expect(recorder.latest.status).toBe("paused");
    });

    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    expect(recorder.latest.elapsedMs).toBe(elapsedBeforeHidden);

    act(() => {
      recorder.latest.resumeRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    await act(async () => {
      vi.advanceTimersByTime(900);
    });
    expect(recorder.latest.elapsedMs).toBeGreaterThan(elapsedBeforeHidden);

    await act(async () => {
      await recorder.latest.stopRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("completed");
    });

    setup.cleanupCanvases();
  });

  it("freezes elapsed time while paused and continues after resume", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    await act(async () => {
      vi.advanceTimersByTime(1_200);
    });
    const elapsedBeforePause = recorder.latest.elapsedMs;
    expect(elapsedBeforePause).toBeGreaterThanOrEqual(1_000);

    act(() => {
      recorder.latest.pauseRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("paused");
    });

    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    expect(recorder.latest.elapsedMs).toBe(elapsedBeforePause);

    act(() => {
      recorder.latest.resumeRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    expect(recorder.latest.elapsedMs).toBeGreaterThan(elapsedBeforePause + 700);
    expect(recorder.latest.elapsedMs).toBeLessThan(elapsedBeforePause + 1_300);

    await act(async () => {
      await recorder.latest.stopRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("completed");
    });

    setup.cleanupCanvases();
  });

  it("computes result duration excluding paused intervals", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    await act(async () => {
      vi.advanceTimersByTime(1_100);
    });
    act(() => {
      recorder.latest.pauseRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("paused");
    });

    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    act(() => {
      recorder.latest.resumeRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });
    await act(async () => {
      vi.advanceTimersByTime(900);
    });

    await act(async () => {
      await recorder.latest.stopRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("completed");
      expect(recorder.latest.result).toBeTruthy();
    });

    const durationMs = recorder.latest.result?.durationMs || 0;
    expect(durationMs).toBeGreaterThanOrEqual(1_800);
    expect(durationMs).toBeLessThan(2_400);

    setup.cleanupCanvases();
  });

  it("excludes preparation delay from recorded duration", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();
    const getUserMedia = navigator.mediaDevices
      .getUserMedia as unknown as ReturnType<typeof vi.fn>;

    const microphoneTrackStop = vi.fn();
    const microphoneTrack = {
      kind: "audio",
      stop: microphoneTrackStop,
    } as unknown as MediaStreamTrack;
    const microphoneStream = {
      getTracks: () => [microphoneTrack],
      getAudioTracks: () => [microphoneTrack],
    } as unknown as MediaStream;
    let resolvePermission: ((value: MediaStream) => void) | null = null;
    getUserMedia.mockImplementation(
      () =>
        new Promise<MediaStream>((resolve) => {
          resolvePermission = resolve;
        }),
    );

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: true,
      });
    });

    act(() => {
      void recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("preparing");
    });

    await act(async () => {
      vi.advanceTimersByTime(5_000);
      resolvePermission?.(microphoneStream);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    await act(async () => {
      vi.advanceTimersByTime(1_100);
    });

    await act(async () => {
      await recorder.latest.stopRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("completed");
      expect(recorder.latest.result).toBeTruthy();
    });

    const durationMs = recorder.latest.result?.durationMs || 0;
    expect(durationMs).toBeGreaterThanOrEqual(900);
    expect(durationMs).toBeLessThan(2_000);
    expect(microphoneTrackStop).toHaveBeenCalledTimes(1);

    setup.cleanupCanvases();
  });

  it("finalizes paused recording duration without counting trailing paused time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    await act(async () => {
      vi.advanceTimersByTime(1_200);
    });
    const elapsedBeforePause = recorder.latest.elapsedMs;
    expect(elapsedBeforePause).toBeGreaterThanOrEqual(1_000);

    act(() => {
      recorder.latest.pauseRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("paused");
    });

    await act(async () => {
      vi.advanceTimersByTime(2_000);
      await recorder.latest.stopRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("completed");
      expect(recorder.latest.result).toBeTruthy();
    });

    const finalizedDuration = recorder.latest.result?.durationMs || 0;
    expect(finalizedDuration).toBeGreaterThanOrEqual(elapsedBeforePause - 120);
    expect(finalizedDuration).toBeLessThan(elapsedBeforePause + 120);

    setup.cleanupCanvases();
  });

  it("treats control actions as no-op when recorder is not active", async () => {
    setMediaRecorderSupport(["video/webm"]);
    setMediaDevicesMock({
      enumerateDevices: vi.fn(async () => []),
    });
    const idleRecorder = renderUseVideoRecorder();

    await act(async () => {
      await idleRecorder.latest.stopRecording();
    });
    act(() => {
      idleRecorder.latest.pauseRecording();
      idleRecorder.latest.resumeRecording();
    });
    expect(idleRecorder.latest.status).toBe("idle");
    expect(idleRecorder.latest.result).toBeNull();

    const setup = setupRecordingFlowMocks();
    const completedRecorder = renderUseVideoRecorder();
    act(() => {
      completedRecorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });
    await act(async () => {
      await completedRecorder.latest.startRecording();
      await completedRecorder.latest.stopRecording();
    });
    await waitFor(() => {
      expect(completedRecorder.latest.status).toBe("completed");
      expect(completedRecorder.latest.result).toBeTruthy();
    });
    const resultBefore = completedRecorder.latest.result;

    await act(async () => {
      await completedRecorder.latest.stopRecording();
    });
    act(() => {
      completedRecorder.latest.pauseRecording();
      completedRecorder.latest.resumeRecording();
    });

    expect(completedRecorder.latest.status).toBe("completed");
    expect(completedRecorder.latest.result).toBe(resultBefore);

    setup.cleanupCanvases();
  });

  it("keeps error state stable when control actions are invoked", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    act(() => {
      setup.emitRecorderError("fatal recorder error");
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("error");
      expect(recorder.latest.error).toBe("fatal recorder error");
    });
    act(() => {
      setup.emitRecorderStop();
    });
    expect(recorder.latest.status).toBe("error");
    expect(recorder.latest.result).toBeNull();

    await act(async () => {
      await recorder.latest.stopRecording();
    });
    act(() => {
      recorder.latest.pauseRecording();
      recorder.latest.resumeRecording();
    });

    expect(recorder.latest.status).toBe("error");
    expect(recorder.latest.error).toBe("fatal recorder error");
    expect(recorder.latest.isRecordingActive).toBe(false);

    setup.cleanupCanvases();
  });

  it("does not trigger download side effects when result is missing", async () => {
    setMediaRecorderSupport(["video/webm"]);
    setMediaDevicesMock({
      enumerateDevices: vi.fn(async () => []),
    });
    const createObjectURLSpy = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:unused");
    const revokeObjectURLSpy = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => {});
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    const recorder = renderUseVideoRecorder();
    await waitFor(() => {
      expect(recorder.latest.devices).toEqual({
        videoInputs: [],
        audioInputs: [],
      });
    });

    act(() => {
      recorder.latest.downloadRecording("demo");
    });

    expect(recorder.latest.result).toBeNull();
    expect(createObjectURLSpy).not.toHaveBeenCalled();
    expect(clickSpy).not.toHaveBeenCalled();
    expect(revokeObjectURLSpy).not.toHaveBeenCalled();
  });

  it("stops recording, downloads result and resets state", async () => {
    const setup = setupRecordingFlowMocks();

    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    await act(async () => {
      await recorder.latest.stopRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("completed");
      expect(recorder.latest.result).toBeTruthy();
    });
    expect(setup.cleanupSpy).toHaveBeenCalledTimes(1);
    expect(setup.videoTrackStop).toHaveBeenCalledTimes(1);

    act(() => {
      recorder.latest.downloadRecording("demo");
    });
    expect(setup.createObjectURLSpy).toHaveBeenCalledTimes(1);
    expect(setup.clickSpy).toHaveBeenCalledTimes(1);
    expect(setup.getDownloadedFileNames()).toEqual(["demo.webm"]);
    expect(setup.revokeObjectURLSpy).toHaveBeenCalledWith("blob:mock-url");

    act(() => {
      recorder.latest.resetResult();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("idle");
      expect(recorder.latest.result).toBeNull();
      expect(recorder.latest.error).toBeNull();
      expect(recorder.latest.elapsedMs).toBe(0);
    });

    setup.cleanupCanvases();
  });

  it("keeps stop flow successful when track cleanup throws", async () => {
    const setup = setupRecordingFlowMocks({ trackStopThrows: true });
    const recorder = renderUseVideoRecorder();
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("recording");
    });

    await act(async () => {
      await recorder.latest.stopRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("completed");
      expect(recorder.latest.result).toBeTruthy();
    });
    expect(setup.videoTrackStop).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);

    setup.cleanupCanvases();
  });

  it("sets error when object URL creation fails during download", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
      await recorder.latest.stopRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("completed");
      expect(recorder.latest.result).toBeTruthy();
    });

    setup.createObjectURLSpy.mockImplementationOnce(() => {
      throw new Error("blob creation failed");
    });

    act(() => {
      recorder.latest.downloadRecording("demo");
    });

    await waitFor(() => {
      expect(recorder.latest.error).toBe("blob creation failed");
    });
    expect(setup.clickSpy).not.toHaveBeenCalled();
    expect(setup.revokeObjectURLSpy).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);

    setup.cleanupCanvases();
  });

  it("cleans up anchor and object URL when download click throws", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
      await recorder.latest.stopRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("completed");
      expect(recorder.latest.result).toBeTruthy();
    });

    const anchorCountBefore = document.querySelectorAll("a").length;
    setup.clickSpy.mockImplementationOnce(() => {
      throw new Error("click failed");
    });

    act(() => {
      recorder.latest.downloadRecording("demo");
    });

    await waitFor(() => {
      expect(recorder.latest.error).toBe("click failed");
    });
    expect(setup.createObjectURLSpy).toHaveBeenCalledTimes(1);
    expect(setup.revokeObjectURLSpy).toHaveBeenCalledWith("blob:mock-url");
    expect(document.querySelectorAll("a").length).toBe(anchorCountBefore);
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);

    setup.cleanupCanvases();
  });

  it("clears previous download error after a later successful retry", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
      await recorder.latest.stopRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("completed");
      expect(recorder.latest.result).toBeTruthy();
    });

    setup.clickSpy.mockImplementationOnce(() => {
      throw new Error("click failed once");
    });

    act(() => {
      recorder.latest.downloadRecording("demo");
    });
    await waitFor(() => {
      expect(recorder.latest.error).toBe("click failed once");
    });

    act(() => {
      recorder.latest.downloadRecording("demo");
    });
    await waitFor(() => {
      expect(recorder.latest.error).toBeNull();
    });

    expect(setup.createObjectURLSpy).toHaveBeenCalledTimes(2);
    expect(setup.clickSpy).toHaveBeenCalledTimes(2);
    expect(setup.revokeObjectURLSpy).toHaveBeenCalledTimes(2);
    expect(setup.getDownloadedFileNames()).toEqual(["demo.webm"]);
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);

    setup.cleanupCanvases();
  });

  it("logs and preserves successful download when object URL revoke throws", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
      await recorder.latest.stopRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("completed");
      expect(recorder.latest.result).toBeTruthy();
    });

    setup.revokeObjectURLSpy.mockImplementationOnce(() => {
      throw new Error("revoke failed");
    });

    expect(() => {
      act(() => {
        recorder.latest.downloadRecording("demo");
      });
    }).not.toThrow();

    expect(setup.createObjectURLSpy).toHaveBeenCalledTimes(1);
    expect(setup.clickSpy).toHaveBeenCalledTimes(1);
    expect(setup.getDownloadedFileNames()).toEqual(["demo.webm"]);
    expect(recorder.latest.error).toBeNull();
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);

    setup.cleanupCanvases();
  });

  it("falls back to default filename when download name is blank", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
      await recorder.latest.stopRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("completed");
      expect(recorder.latest.result).toBeTruthy();
    });

    act(() => {
      recorder.latest.downloadRecording("   ");
    });

    expect(setup.createObjectURLSpy).toHaveBeenCalledTimes(1);
    expect(setup.clickSpy).toHaveBeenCalledTimes(1);
    expect(setup.getDownloadedFileNames()).toEqual([
      "excalidraw-recording.webm",
    ]);
    expect(setup.revokeObjectURLSpy).toHaveBeenCalledWith("blob:mock-url");

    setup.cleanupCanvases();
  });

  it("avoids appending duplicate extension when download name already has it", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
      await recorder.latest.stopRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("completed");
      expect(recorder.latest.result).toBeTruthy();
    });

    act(() => {
      recorder.latest.downloadRecording("demo.webm");
    });

    expect(setup.createObjectURLSpy).toHaveBeenCalledTimes(1);
    expect(setup.clickSpy).toHaveBeenCalledTimes(1);
    expect(setup.getDownloadedFileNames()).toEqual(["demo.webm"]);
    expect(setup.revokeObjectURLSpy).toHaveBeenCalledWith("blob:mock-url");

    setup.cleanupCanvases();
  });

  it("normalizes mismatched trailing video extension to output format", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
      await recorder.latest.stopRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("completed");
      expect(recorder.latest.result).toBeTruthy();
    });

    act(() => {
      recorder.latest.downloadRecording("demo.mp4");
    });

    expect(setup.createObjectURLSpy).toHaveBeenCalledTimes(1);
    expect(setup.clickSpy).toHaveBeenCalledTimes(1);
    expect(setup.getDownloadedFileNames()).toEqual(["demo.webm"]);
    expect(setup.revokeObjectURLSpy).toHaveBeenCalledWith("blob:mock-url");

    setup.cleanupCanvases();
  });

  it("strips chained trailing video extensions before applying output format", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
      await recorder.latest.stopRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("completed");
      expect(recorder.latest.result).toBeTruthy();
    });

    act(() => {
      recorder.latest.downloadRecording("demo.webm.mp4");
    });

    expect(setup.createObjectURLSpy).toHaveBeenCalledTimes(1);
    expect(setup.clickSpy).toHaveBeenCalledTimes(1);
    expect(setup.getDownloadedFileNames()).toEqual(["demo.webm"]);
    expect(setup.revokeObjectURLSpy).toHaveBeenCalledWith("blob:mock-url");

    setup.cleanupCanvases();
  });

  it("sanitizes invalid filename characters when downloading recording", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
      await recorder.latest.stopRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("completed");
      expect(recorder.latest.result).toBeTruthy();
    });

    act(() => {
      recorder.latest.downloadRecording("  demo///name??  ");
    });

    expect(setup.createObjectURLSpy).toHaveBeenCalledTimes(1);
    expect(setup.clickSpy).toHaveBeenCalledTimes(1);
    expect(setup.getDownloadedFileNames()).toEqual(["demo-name.webm"]);
    expect(setup.revokeObjectURLSpy).toHaveBeenCalledWith("blob:mock-url");

    setup.cleanupCanvases();
  });

  it("sanitizes control characters in download filenames", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
      await recorder.latest.stopRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("completed");
      expect(recorder.latest.result).toBeTruthy();
    });

    act(() => {
      recorder.latest.downloadRecording("demo\u0000name\n");
    });

    expect(setup.createObjectURLSpy).toHaveBeenCalledTimes(1);
    expect(setup.clickSpy).toHaveBeenCalledTimes(1);
    expect(setup.getDownloadedFileNames()).toEqual(["demo-name.webm"]);
    expect(setup.revokeObjectURLSpy).toHaveBeenCalledWith("blob:mock-url");

    setup.cleanupCanvases();
  });

  it("falls back to default filename when sanitized value becomes empty", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
      await recorder.latest.stopRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("completed");
      expect(recorder.latest.result).toBeTruthy();
    });

    act(() => {
      recorder.latest.downloadRecording(' /\\:*?"<>| . ');
    });

    expect(setup.createObjectURLSpy).toHaveBeenCalledTimes(1);
    expect(setup.clickSpy).toHaveBeenCalledTimes(1);
    expect(setup.getDownloadedFileNames()).toEqual([
      "excalidraw-recording.webm",
    ]);
    expect(setup.revokeObjectURLSpy).toHaveBeenCalledWith("blob:mock-url");

    setup.cleanupCanvases();
  });

  it("truncates overly long download filenames to safe length", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
      await recorder.latest.stopRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("completed");
      expect(recorder.latest.result).toBeTruthy();
    });

    const longName = "a".repeat(220);
    act(() => {
      recorder.latest.downloadRecording(longName);
    });

    expect(setup.createObjectURLSpy).toHaveBeenCalledTimes(1);
    expect(setup.clickSpy).toHaveBeenCalledTimes(1);
    const [downloadedName] = setup.getDownloadedFileNames();
    expect(downloadedName).toBe(`${"a".repeat(120)}.webm`);
    expect(setup.revokeObjectURLSpy).toHaveBeenCalledWith("blob:mock-url");

    setup.cleanupCanvases();
  });

  it("falls back to default filename for windows reserved names", async () => {
    const setup = setupRecordingFlowMocks();
    const recorder = renderUseVideoRecorder();

    act(() => {
      recorder.latest.setSettings({
        cameraEnabled: false,
        microphoneEnabled: false,
      });
    });

    await act(async () => {
      await recorder.latest.startRecording();
      await recorder.latest.stopRecording();
    });
    await waitFor(() => {
      expect(recorder.latest.status).toBe("completed");
      expect(recorder.latest.result).toBeTruthy();
    });

    act(() => {
      recorder.latest.downloadRecording("con");
      recorder.latest.downloadRecording("con.txt");
    });

    expect(setup.createObjectURLSpy).toHaveBeenCalledTimes(2);
    expect(setup.clickSpy).toHaveBeenCalledTimes(2);
    expect(setup.getDownloadedFileNames()).toEqual([
      "excalidraw-recording.webm",
      "excalidraw-recording.webm",
    ]);
    expect(setup.revokeObjectURLSpy).toHaveBeenCalledWith("blob:mock-url");

    setup.cleanupCanvases();
  });

  it("sets error when requesting permissions without getUserMedia", async () => {
    setMediaRecorderSupport(["video/webm"]);
    setMediaDevicesMock({
      enumerateDevices: vi.fn(async () => []),
    });

    const recorder = renderUseVideoRecorder();

    await act(async () => {
      await recorder.latest.requestMediaPermissions();
    });

    await waitFor(() => {
      expect(recorder.latest.isRequestingPermissions).toBe(false);
      expect(recorder.latest.error).toBe(
        "This browser does not support video recording.",
      );
    });
  });

  it("sets error when requesting permissions without MediaRecorder support", async () => {
    delete (globalThis as any).MediaRecorder;
    const getUserMedia = vi.fn();
    setMediaDevicesMock({
      enumerateDevices: vi.fn(async () => []),
      getUserMedia,
    });

    const recorder = renderUseVideoRecorder();

    await act(async () => {
      await recorder.latest.requestMediaPermissions();
    });

    await waitFor(() => {
      expect(recorder.latest.isRequestingPermissions).toBe(false);
      expect(recorder.latest.error).toBe(
        "This browser does not support video recording.",
      );
    });
    expect(getUserMedia).not.toHaveBeenCalled();
  });
});
