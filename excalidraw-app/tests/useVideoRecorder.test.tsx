import { act, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EVENT } from "@excalidraw/common";

import { STORAGE_KEYS } from "../app_constants";
import { getDefaultVideoRecorderSettings } from "../components/video-recorder/videoRecorder.config";
import {
  mapVideoRecorderErrorMessage,
  useVideoRecorder,
} from "../components/video-recorder/useVideoRecorder";

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
}) => {
  const cleanupSpy = vi.fn();
  const pauseSpy = vi.fn();
  const resumeSpy = vi.fn();
  const videoTrackStop = vi.fn();
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
    static isTypeSupported = (mimeType: string) => mimeType.includes("webm");
    state: RecordingState = "inactive";
    mimeType: string;
    ondataavailable: ((event: BlobEvent) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: ((event: any) => void) | null = null;
    private stopListeners = new Set<() => void>();

    constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
      this.mimeType = options?.mimeType || "video/webm";
      latestRecorder = this;
    }
    start() {
      this.state = "recording";
      this.ondataavailable?.({
        data: new Blob(["chunk"], { type: this.mimeType }),
      } as BlobEvent);
    }
    pause() {
      this.state = "paused";
      pauseSpy();
    }
    resume() {
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
  globalThis.MediaRecorder = FunctionalMediaRecorder as any;

  const { cleanup } = createExcalidrawCanvases();
  const createObjectURLSpy = vi
    .spyOn(URL, "createObjectURL")
    .mockReturnValue("blob:mock-url");
  const revokeObjectURLSpy = vi
    .spyOn(URL, "revokeObjectURL")
    .mockImplementation(() => {});
  const clickSpy = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => {});

  return {
    cleanupSpy,
    pauseSpy,
    resumeSpy,
    videoTrackStop,
    captureStreamSpy,
    getStopCallCount: () => stopCallCount,
    flushStop: () => flushStop?.(),
    emitRecorderError: (message?: string) => {
      latestRecorder?.onerror?.({
        error: message ? new Error(message) : undefined,
      });
    },
    emitRecorderStop: () => {
      latestRecorder?.onstop?.();
    },
    createObjectURLSpy,
    revokeObjectURLSpy,
    clickSpy,
    cleanupCanvases: cleanup,
  };
};

const renderUseVideoRecorder = () => {
  let latest: ReturnType<typeof useVideoRecorder> | null = null;

  const Probe = () => {
    latest = useVideoRecorder();
    return null;
  };

  render(<Probe />);

  return {
    get latest() {
      if (!latest) {
        throw new Error("useVideoRecorder is not initialized");
      }
      return latest;
    },
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
      expect(recorder.latest.error).toBeTruthy();
    });
  });
});
