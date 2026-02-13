import { act, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { STORAGE_KEYS } from "../app_constants";
import { getDefaultVideoRecorderSettings } from "../components/video-recorder/videoRecorder.config";
import {
  mapVideoRecorderErrorMessage,
  useVideoRecorder,
} from "../components/video-recorder/useVideoRecorder";

const OriginalMediaRecorder = globalThis.MediaRecorder;
const OriginalMediaDevices = navigator.mediaDevices;

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

  if (OriginalMediaDevices) {
    setMediaDevicesMock(OriginalMediaDevices);
  } else {
    delete (navigator as any).mediaDevices;
  }

  localStorage.removeItem(STORAGE_KEYS.LOCAL_STORAGE_VIDEO_RECORDER);
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
