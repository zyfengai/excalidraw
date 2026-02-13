import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { getDefaultAppState } from "@excalidraw/excalidraw/appState";
import { UIAppStateContext } from "@excalidraw/excalidraw/context/ui-appState";
import { EditorJotaiProvider } from "@excalidraw/excalidraw/editor-jotai";

import { VideoRecorderDialog } from "../components/video-recorder/VideoRecorderDialog";
import {
  DEFAULT_VIDEO_RECORDER_CAMERA_LAYOUT,
  getDefaultVideoRecorderSettings,
} from "../components/video-recorder/videoRecorder.config";

import type { VideoRecorderStatus } from "../components/video-recorder/videoRecorder.types";

vi.mock("@excalidraw/excalidraw/i18n", () => {
  const dictionary: Record<string, string> = {
    "videoRecorder.title": "Video recorder",
    "videoRecorder.actions.requestPermissions":
      "Enable camera & microphone access",
    "videoRecorder.actions.startRecording": "Start recording",
    "videoRecorder.camera.shape": "Camera shape",
    "videoRecorder.camera.sizeWidth": "Camera width",
    "videoRecorder.camera.sizeHeight": "Camera height",
    "videoRecorder.camera.resetLayout": "Reset camera position & size",
    "videoRecorder.preview.camera": "Camera overlay",
    "buttons.cancel": "Cancel",
  };

  const translate = (key: string) => dictionary[key] ?? key;

  return {
    t: translate,
    useI18n: () => ({ t: translate, langCode: "en" }),
  };
});

const getUIAppState = () =>
  ({
    ...getDefaultAppState(),
    width: 1200,
    height: 800,
    offsetTop: 0,
    offsetLeft: 0,
  } as any);

const renderDialog = (
  opts: Partial<{
    settings: ReturnType<typeof getDefaultVideoRecorderSettings>;
    onCameraLayoutChange: ReturnType<typeof vi.fn>;
    onRequestPermissions: ReturnType<typeof vi.fn>;
    onRefreshDevices: ReturnType<typeof vi.fn>;
    onStart: ReturnType<typeof vi.fn>;
    status: VideoRecorderStatus;
    isRequestingPermissions: boolean;
    isOpen: boolean;
    devices: {
      videoInputs: Array<{ deviceId: string; label: string }>;
      audioInputs: Array<{ deviceId: string; label: string }>;
    };
    capabilities: {
      isSupported: boolean;
      supportedMimeTypes: string[];
    };
  }> = {},
) => {
  const onCameraLayoutChange = opts.onCameraLayoutChange ?? vi.fn();
  const onRequestPermissions = opts.onRequestPermissions ?? vi.fn();
  const onRefreshDevices =
    opts.onRefreshDevices ?? vi.fn(async () => undefined);
  const onStart = opts.onStart ?? vi.fn(async () => undefined);

  const settings = opts.settings ?? {
    ...getDefaultVideoRecorderSettings(),
    cameraEnabled: true,
  };

  const view = render(
    <EditorJotaiProvider>
      <UIAppStateContext.Provider value={getUIAppState()}>
        <VideoRecorderDialog
          isOpen={opts.isOpen ?? true}
          capabilities={
            opts.capabilities ?? {
              isSupported: true,
              supportedMimeTypes: ["video/webm"],
            }
          }
          status={opts.status ?? "idle"}
          error={null}
          settings={settings}
          devices={opts.devices ?? { videoInputs: [], audioInputs: [] }}
          onClose={vi.fn()}
          onRefreshDevices={onRefreshDevices}
          onStart={onStart}
          onRequestPermissions={onRequestPermissions}
          isRequestingPermissions={opts.isRequestingPermissions ?? false}
          onSettingsChange={vi.fn()}
          onCameraLayoutChange={onCameraLayoutChange}
        />
      </UIAppStateContext.Provider>
    </EditorJotaiProvider>,
  );

  return {
    ...view,
    onCameraLayoutChange,
    onRefreshDevices,
    onRequestPermissions,
    onStart,
  };
};

describe("VideoRecorderDialog", () => {
  it("triggers permission request action", () => {
    const { onRequestPermissions } = renderDialog({
      onRequestPermissions: vi.fn(async () => undefined),
    });

    fireEvent.click(
      screen.getByRole("button", {
        name: /Enable camera & microphone access/i,
      }),
    );

    expect(onRequestPermissions).toHaveBeenCalledTimes(1);
  });

  it("falls back to auto when selected devices are unavailable", () => {
    const settings = {
      ...getDefaultVideoRecorderSettings(),
      cameraEnabled: true,
      selectedVideoDeviceId: "missing-camera",
      selectedAudioDeviceId: "missing-mic",
    };

    renderDialog({
      settings,
      devices: {
        videoInputs: [{ deviceId: "camera-1", label: "Camera 1" }],
        audioInputs: [{ deviceId: "mic-1", label: "Mic 1" }],
      },
    });

    const cameraSelect = screen.getByLabelText(
      "videoRecorder.camera.device",
    ) as HTMLSelectElement;
    const microphoneSelect = screen.getByLabelText(
      "videoRecorder.microphone.device",
    ) as HTMLSelectElement;

    expect(cameraSelect.value).toBe("");
    expect(microphoneSelect.value).toBe("");
  });

  it("normalizes whitespace-wrapped selected device ids in selectors", () => {
    const settings = {
      ...getDefaultVideoRecorderSettings(),
      cameraEnabled: true,
      selectedVideoDeviceId: " camera-1 ",
      selectedAudioDeviceId: " mic-1 ",
    };

    renderDialog({
      settings,
      devices: {
        videoInputs: [{ deviceId: "camera-1", label: "Camera 1" }],
        audioInputs: [{ deviceId: "mic-1", label: "Mic 1" }],
      },
    });

    const cameraSelect = screen.getByLabelText(
      "videoRecorder.camera.device",
    ) as HTMLSelectElement;
    const microphoneSelect = screen.getByLabelText(
      "videoRecorder.microphone.device",
    ) as HTMLSelectElement;

    expect(cameraSelect.value).toBe("camera-1");
    expect(microphoneSelect.value).toBe("mic-1");
  });

  it("falls back to supported video profile values when settings are invalid", () => {
    const settings = {
      ...getDefaultVideoRecorderSettings(),
      cameraEnabled: true,
      aspectRatio: "bad-ratio" as unknown as ReturnType<
        typeof getDefaultVideoRecorderSettings
      >["aspectRatio"],
      resolution: "bad-resolution" as unknown as ReturnType<
        typeof getDefaultVideoRecorderSettings
      >["resolution"],
      fps: 999,
      mimeType: "video/unknown",
    };

    renderDialog({
      settings,
      capabilities: {
        isSupported: true,
        supportedMimeTypes: ["video/webm", "video/mp4"],
      },
    });

    const ratioSelect = screen.getByLabelText(
      "videoRecorder.video.aspectRatio",
    ) as HTMLSelectElement;
    const resolutionSelect = screen.getByLabelText(
      "videoRecorder.video.resolution",
    ) as HTMLSelectElement;
    const fpsSelect = screen.getByLabelText(
      "videoRecorder.video.fps",
    ) as HTMLSelectElement;
    const formatSelect = screen.getByLabelText(
      "videoRecorder.video.format",
    ) as HTMLSelectElement;

    expect(ratioSelect.value).toBe("16:9");
    expect(resolutionSelect.value).toBe("1080p");
    expect(fpsSelect.value).toBe("60");
    expect(formatSelect.value).toBe("video/webm");
  });

  it("matches supported mimeType regardless of input casing", () => {
    const settings = {
      ...getDefaultVideoRecorderSettings(),
      cameraEnabled: true,
      mimeType: " VIDEO/MP4 ",
    };

    renderDialog({
      settings,
      capabilities: {
        isSupported: true,
        supportedMimeTypes: ["video/webm", "video/mp4"],
      },
    });

    const formatSelect = screen.getByLabelText(
      "videoRecorder.video.format",
    ) as HTMLSelectElement;
    expect(formatSelect.value).toBe("video/mp4");
  });

  it("matches supported mimeType when codec spacing differs", () => {
    const settings = {
      ...getDefaultVideoRecorderSettings(),
      cameraEnabled: true,
      mimeType: "video/webm; codecs = vp9,opus",
    };

    renderDialog({
      settings,
      capabilities: {
        isSupported: true,
        supportedMimeTypes: ["video/webm;codecs=vp9,opus", "video/webm"],
      },
    });

    const formatSelect = screen.getByLabelText(
      "videoRecorder.video.format",
    ) as HTMLSelectElement;
    expect(formatSelect.value).toBe("video/webm;codecs=vp9,opus");
  });

  it("normalizes whitespace-wrapped video profile values for selects", () => {
    const settings = {
      ...getDefaultVideoRecorderSettings(),
      cameraEnabled: true,
      aspectRatio: " 4 : 3 " as unknown as ReturnType<
        typeof getDefaultVideoRecorderSettings
      >["aspectRatio"],
      resolution: " 720 p " as unknown as ReturnType<
        typeof getDefaultVideoRecorderSettings
      >["resolution"],
    };

    renderDialog({
      settings,
    });

    const ratioSelect = screen.getByLabelText(
      "videoRecorder.video.aspectRatio",
    ) as HTMLSelectElement;
    const resolutionSelect = screen.getByLabelText(
      "videoRecorder.video.resolution",
    ) as HTMLSelectElement;

    expect(ratioSelect.value).toBe("4:3");
    expect(resolutionSelect.value).toBe("720p");
  });

  it("refreshes devices only on open transitions", () => {
    const initialRefresh = vi.fn(async () => undefined);
    const nextRefresh = vi.fn(async () => undefined);
    const settings = {
      ...getDefaultVideoRecorderSettings(),
      cameraEnabled: true,
    };

    const { rerender } = renderDialog({
      isOpen: false,
      settings,
      onRefreshDevices: initialRefresh,
    });

    expect(initialRefresh).toHaveBeenCalledTimes(0);

    rerender(
      <EditorJotaiProvider>
        <UIAppStateContext.Provider value={getUIAppState()}>
          <VideoRecorderDialog
            isOpen={true}
            capabilities={{
              isSupported: true,
              supportedMimeTypes: ["video/webm"],
            }}
            status="idle"
            error={null}
            settings={settings}
            devices={{ videoInputs: [], audioInputs: [] }}
            onClose={vi.fn()}
            onRefreshDevices={initialRefresh}
            onStart={vi.fn(async () => undefined)}
            onRequestPermissions={vi.fn(async () => undefined)}
            isRequestingPermissions={false}
            onSettingsChange={vi.fn()}
            onCameraLayoutChange={vi.fn()}
          />
        </UIAppStateContext.Provider>
      </EditorJotaiProvider>,
    );

    expect(initialRefresh).toHaveBeenCalledTimes(1);

    rerender(
      <EditorJotaiProvider>
        <UIAppStateContext.Provider value={getUIAppState()}>
          <VideoRecorderDialog
            isOpen={true}
            capabilities={{
              isSupported: true,
              supportedMimeTypes: ["video/webm"],
            }}
            status="idle"
            error={null}
            settings={settings}
            devices={{ videoInputs: [], audioInputs: [] }}
            onClose={vi.fn()}
            onRefreshDevices={nextRefresh}
            onStart={vi.fn(async () => undefined)}
            onRequestPermissions={vi.fn(async () => undefined)}
            isRequestingPermissions={false}
            onSettingsChange={vi.fn()}
            onCameraLayoutChange={vi.fn()}
          />
        </UIAppStateContext.Provider>
      </EditorJotaiProvider>,
    );

    expect(initialRefresh).toHaveBeenCalledTimes(1);
    expect(nextRefresh).toHaveBeenCalledTimes(0);

    rerender(
      <EditorJotaiProvider>
        <UIAppStateContext.Provider value={getUIAppState()}>
          <VideoRecorderDialog
            isOpen={false}
            capabilities={{
              isSupported: true,
              supportedMimeTypes: ["video/webm"],
            }}
            status="idle"
            error={null}
            settings={settings}
            devices={{ videoInputs: [], audioInputs: [] }}
            onClose={vi.fn()}
            onRefreshDevices={nextRefresh}
            onStart={vi.fn(async () => undefined)}
            onRequestPermissions={vi.fn(async () => undefined)}
            isRequestingPermissions={false}
            onSettingsChange={vi.fn()}
            onCameraLayoutChange={vi.fn()}
          />
        </UIAppStateContext.Provider>
      </EditorJotaiProvider>,
    );

    rerender(
      <EditorJotaiProvider>
        <UIAppStateContext.Provider value={getUIAppState()}>
          <VideoRecorderDialog
            isOpen={true}
            capabilities={{
              isSupported: true,
              supportedMimeTypes: ["video/webm"],
            }}
            status="idle"
            error={null}
            settings={settings}
            devices={{ videoInputs: [], audioInputs: [] }}
            onClose={vi.fn()}
            onRefreshDevices={nextRefresh}
            onStart={vi.fn(async () => undefined)}
            onRequestPermissions={vi.fn(async () => undefined)}
            isRequestingPermissions={false}
            onSettingsChange={vi.fn()}
            onCameraLayoutChange={vi.fn()}
          />
        </UIAppStateContext.Provider>
      </EditorJotaiProvider>,
    );

    expect(nextRefresh).toHaveBeenCalledTimes(1);
  });

  it("disables permission request while permissions are in-flight", () => {
    const { onRequestPermissions } = renderDialog({
      onRequestPermissions: vi.fn(async () => undefined),
      isRequestingPermissions: true,
    });

    const requestButton = screen.getByRole("button", {
      name: /Enable camera & microphone access/i,
    });
    expect(requestButton).toBeDisabled();
    fireEvent.click(requestButton);

    expect(onRequestPermissions).toHaveBeenCalledTimes(0);
  });

  it("disables permission request while recording is active", () => {
    const { onRequestPermissions } = renderDialog({
      status: "recording",
      onRequestPermissions: vi.fn(async () => undefined),
    });

    const requestButton = screen.getByRole("button", {
      name: /Enable camera & microphone access/i,
    });
    expect(requestButton).toBeDisabled();
    fireEvent.click(requestButton);

    expect(onRequestPermissions).toHaveBeenCalledTimes(0);
  });

  it("disables permission request when browser support is missing", () => {
    const { onRequestPermissions } = renderDialog({
      capabilities: {
        isSupported: false,
        supportedMimeTypes: [],
      },
      onRequestPermissions: vi.fn(async () => undefined),
    });

    const requestButton = screen.getByRole("button", {
      name: /Enable camera & microphone access/i,
    });
    expect(requestButton).toBeDisabled();
    fireEvent.click(requestButton);

    expect(onRequestPermissions).toHaveBeenCalledTimes(0);
  });

  it("disables format selector when browser support is missing", () => {
    renderDialog({
      capabilities: {
        isSupported: false,
        supportedMimeTypes: [],
      },
    });

    const formatSelect = screen.getByLabelText(
      "videoRecorder.video.format",
    ) as HTMLSelectElement;
    expect(formatSelect).toBeDisabled();
    expect(formatSelect.value).toBe("");
  });

  it("disables start action while permissions are in-flight", () => {
    const { onStart } = renderDialog({
      isRequestingPermissions: true,
    });

    const startButton = screen.getByRole("button", {
      name: /Start recording/i,
    });
    expect(startButton).toBeDisabled();
    fireEvent.click(startButton);

    expect(onStart).toHaveBeenCalledTimes(0);
  });

  it("starts recording when start action is enabled", () => {
    const { onStart } = renderDialog();

    fireEvent.click(
      screen.getByRole("button", {
        name: /Start recording/i,
      }),
    );

    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("disables start action while preparing", () => {
    const { onStart } = renderDialog({
      status: "preparing",
    });

    const startButton = screen.getByRole("button", {
      name: /Start recording/i,
    });
    expect(startButton).toBeDisabled();
    fireEvent.click(startButton);
    expect(onStart).toHaveBeenCalledTimes(0);
  });

  it("disables start action while recording is active", () => {
    const { onStart } = renderDialog({
      status: "recording",
    });

    const startButton = screen.getByRole("button", {
      name: /Start recording/i,
    });
    expect(startButton).toBeDisabled();
    fireEvent.click(startButton);
    expect(onStart).toHaveBeenCalledTimes(0);
  });

  it("keeps start action enabled after recording is completed", () => {
    const { onStart } = renderDialog({
      status: "completed",
    });

    const startButton = screen.getByRole("button", {
      name: /Start recording/i,
    });
    expect(startButton).not.toBeDisabled();
    fireEvent.click(startButton);
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("disables start action when browser support is missing", () => {
    const { onStart } = renderDialog({
      capabilities: {
        isSupported: false,
        supportedMimeTypes: [],
      },
    });

    const startButton = screen.getByRole("button", {
      name: /Start recording/i,
    });
    expect(startButton).toBeDisabled();
    fireEvent.click(startButton);
    expect(onStart).toHaveBeenCalledTimes(0);
  });

  it("updates camera width in non-circle mode", () => {
    const { onCameraLayoutChange } = renderDialog({
      settings: {
        ...getDefaultVideoRecorderSettings(),
        cameraEnabled: true,
        camera: {
          ...getDefaultVideoRecorderSettings().camera,
          shape: "rounded",
        },
      },
    });

    fireEvent.change(screen.getByLabelText(/Camera width/i), {
      target: { value: "40" },
    });

    expect(onCameraLayoutChange).toHaveBeenCalledWith({ width: 0.4 });
  });

  it("keeps square dimensions in circle mode", () => {
    const { onCameraLayoutChange } = renderDialog({
      settings: {
        ...getDefaultVideoRecorderSettings(),
        cameraEnabled: true,
        camera: {
          ...getDefaultVideoRecorderSettings().camera,
          shape: "circle",
        },
      },
    });

    fireEvent.change(screen.getByLabelText(/Camera width/i), {
      target: { value: "30" },
    });

    expect(onCameraLayoutChange).toHaveBeenCalledWith({
      width: 0.3,
      height: 0.3,
    });
  });

  it("normalizes dimensions when switching shape to circle", () => {
    const { onCameraLayoutChange } = renderDialog({
      settings: {
        ...getDefaultVideoRecorderSettings(),
        cameraEnabled: true,
        camera: {
          ...getDefaultVideoRecorderSettings().camera,
          shape: "rounded",
          width: 0.2,
          height: 0.35,
        },
      },
    });

    fireEvent.change(screen.getByLabelText(/Camera shape/i), {
      target: { value: "circle" },
    });

    expect(onCameraLayoutChange).toHaveBeenCalledWith({
      shape: "circle",
      width: 0.35,
      height: 0.35,
    });
  });

  it("resets camera layout to defaults", () => {
    const { onCameraLayoutChange } = renderDialog();

    fireEvent.click(
      screen.getByRole("button", { name: /Reset camera position & size/i }),
    );

    expect(onCameraLayoutChange).toHaveBeenCalledWith({
      x: DEFAULT_VIDEO_RECORDER_CAMERA_LAYOUT.x,
      y: DEFAULT_VIDEO_RECORDER_CAMERA_LAYOUT.y,
      width: DEFAULT_VIDEO_RECORDER_CAMERA_LAYOUT.width,
      height: DEFAULT_VIDEO_RECORDER_CAMERA_LAYOUT.height,
    });
  });

  it("ignores overlay drag when preview size is unavailable", () => {
    const { onCameraLayoutChange } = renderDialog({
      settings: {
        ...getDefaultVideoRecorderSettings(),
        cameraEnabled: true,
      },
    });

    const preview = document.querySelector(
      ".video-recorder-dialog__preview",
    ) as HTMLDivElement;
    expect(preview).not.toBeNull();
    vi.spyOn(preview, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
      toJSON: () => ({}),
    } as DOMRect);

    const overlay = document.querySelector(
      ".video-recorder-dialog__camera-overlay",
    ) as HTMLDivElement;
    expect(overlay).not.toBeNull();

    fireEvent.pointerDown(overlay, {
      clientX: 100,
      clientY: 100,
    });
    fireEvent.pointerMove(window, {
      clientX: 220,
      clientY: 260,
    });
    fireEvent.pointerUp(window);

    expect(onCameraLayoutChange).toHaveBeenCalledTimes(0);
  });

  it("ignores overlay drag when preview size is non-finite", () => {
    const { onCameraLayoutChange } = renderDialog({
      settings: {
        ...getDefaultVideoRecorderSettings(),
        cameraEnabled: true,
      },
    });

    const preview = document.querySelector(
      ".video-recorder-dialog__preview",
    ) as HTMLDivElement;
    expect(preview).not.toBeNull();
    vi.spyOn(preview, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 0,
      bottom: 0,
      width: Number.NaN,
      height: 400,
      toJSON: () => ({}),
    } as DOMRect);

    const overlay = document.querySelector(
      ".video-recorder-dialog__camera-overlay",
    ) as HTMLDivElement;
    expect(overlay).not.toBeNull();

    fireEvent.pointerDown(overlay, {
      button: 0,
      clientX: 110,
      clientY: 90,
    });
    fireEvent.pointerMove(window, {
      clientX: 210,
      clientY: 190,
    });
    fireEvent.pointerUp(window);

    expect(onCameraLayoutChange).toHaveBeenCalledTimes(0);
  });

  it("ignores overlay drag updates when pointer coordinates are non-finite", () => {
    const { onCameraLayoutChange } = renderDialog({
      settings: {
        ...getDefaultVideoRecorderSettings(),
        cameraEnabled: true,
      },
    });

    const preview = document.querySelector(
      ".video-recorder-dialog__preview",
    ) as HTMLDivElement;
    expect(preview).not.toBeNull();
    vi.spyOn(preview, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 1000,
      bottom: 500,
      width: 1000,
      height: 500,
      toJSON: () => ({}),
    } as DOMRect);

    const overlay = document.querySelector(
      ".video-recorder-dialog__camera-overlay",
    ) as HTMLDivElement;
    expect(overlay).not.toBeNull();

    fireEvent.pointerDown(overlay, {
      button: 0,
      pointerId: 1,
      clientX: 100,
      clientY: 90,
    });
    fireEvent.pointerMove(window, {
      pointerId: 1,
      clientX: Number.NaN,
      clientY: 200,
    });
    fireEvent.pointerUp(window, {
      pointerId: 1,
      clientX: 100,
      clientY: 90,
    });

    expect(onCameraLayoutChange).toHaveBeenCalledTimes(0);
  });

  it("ignores overlay drag when pointerdown coordinates are non-finite", () => {
    const { onCameraLayoutChange } = renderDialog({
      settings: {
        ...getDefaultVideoRecorderSettings(),
        cameraEnabled: true,
      },
    });

    const preview = document.querySelector(
      ".video-recorder-dialog__preview",
    ) as HTMLDivElement;
    expect(preview).not.toBeNull();
    vi.spyOn(preview, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 1000,
      bottom: 500,
      width: 1000,
      height: 500,
      toJSON: () => ({}),
    } as DOMRect);

    const overlay = document.querySelector(
      ".video-recorder-dialog__camera-overlay",
    ) as HTMLDivElement;
    expect(overlay).not.toBeNull();

    fireEvent.pointerDown(overlay, {
      button: 0,
      pointerId: 1,
      clientX: Number.NaN,
      clientY: 100,
    });
    fireEvent.pointerMove(window, {
      pointerId: 1,
      clientX: 220,
      clientY: 160,
    });
    fireEvent.pointerUp(window, {
      pointerId: 1,
      clientX: 220,
      clientY: 160,
    });

    expect(onCameraLayoutChange).toHaveBeenCalledTimes(0);
  });

  it("clears drag interaction when mouse buttons are released before move", () => {
    const { onCameraLayoutChange } = renderDialog({
      settings: {
        ...getDefaultVideoRecorderSettings(),
        cameraEnabled: true,
      },
    });

    const preview = document.querySelector(
      ".video-recorder-dialog__preview",
    ) as HTMLDivElement;
    expect(preview).not.toBeNull();
    vi.spyOn(preview, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 1000,
      bottom: 500,
      width: 1000,
      height: 500,
      toJSON: () => ({}),
    } as DOMRect);

    const overlay = document.querySelector(
      ".video-recorder-dialog__camera-overlay",
    ) as HTMLDivElement;
    expect(overlay).not.toBeNull();

    fireEvent.pointerDown(overlay, {
      pointerType: "mouse",
      pointerId: 1,
      button: 0,
      clientX: 100,
      clientY: 100,
    });
    fireEvent.pointerMove(window, {
      pointerType: "mouse",
      pointerId: 1,
      buttons: 0,
      clientX: 220,
      clientY: 160,
    });
    fireEvent.pointerMove(window, {
      pointerType: "mouse",
      pointerId: 1,
      buttons: 1,
      clientX: 240,
      clientY: 180,
    });

    expect(onCameraLayoutChange).toHaveBeenCalledTimes(0);
  });

  it("ignores overlay drag on non-primary pointer button", () => {
    const { onCameraLayoutChange } = renderDialog({
      settings: {
        ...getDefaultVideoRecorderSettings(),
        cameraEnabled: true,
      },
    });

    const overlay = document.querySelector(
      ".video-recorder-dialog__camera-overlay",
    ) as HTMLDivElement;
    expect(overlay).not.toBeNull();

    fireEvent.pointerDown(overlay, {
      button: 2,
      pointerType: "mouse",
      clientX: 120,
      clientY: 80,
    });
    fireEvent.pointerMove(window, {
      clientX: 220,
      clientY: 160,
    });
    fireEvent.pointerUp(window);

    expect(onCameraLayoutChange).toHaveBeenCalledTimes(0);
  });

  it("ignores overlay drag on non-primary touch pointer", () => {
    const { onCameraLayoutChange } = renderDialog({
      settings: {
        ...getDefaultVideoRecorderSettings(),
        cameraEnabled: true,
      },
    });

    const preview = document.querySelector(
      ".video-recorder-dialog__preview",
    ) as HTMLDivElement;
    expect(preview).not.toBeNull();
    vi.spyOn(preview, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 1000,
      bottom: 500,
      width: 1000,
      height: 500,
      toJSON: () => ({}),
    } as DOMRect);

    const overlay = document.querySelector(
      ".video-recorder-dialog__camera-overlay",
    ) as HTMLDivElement;
    expect(overlay).not.toBeNull();

    fireEvent.pointerDown(overlay, {
      pointerType: "touch",
      pointerId: 2,
      isPrimary: false,
      clientX: 100,
      clientY: 90,
    });
    fireEvent.pointerMove(window, {
      pointerType: "touch",
      pointerId: 2,
      clientX: 240,
      clientY: 180,
    });
    fireEvent.pointerUp(window, {
      pointerType: "touch",
      pointerId: 2,
      clientX: 240,
      clientY: 180,
    });

    expect(onCameraLayoutChange).toHaveBeenCalledTimes(0);
  });

  it("cancels overlay drag on pointercancel", () => {
    const { onCameraLayoutChange } = renderDialog({
      settings: {
        ...getDefaultVideoRecorderSettings(),
        cameraEnabled: true,
      },
    });

    const preview = document.querySelector(
      ".video-recorder-dialog__preview",
    ) as HTMLDivElement;
    expect(preview).not.toBeNull();
    vi.spyOn(preview, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 1000,
      bottom: 500,
      width: 1000,
      height: 500,
      toJSON: () => ({}),
    } as DOMRect);

    const overlay = document.querySelector(
      ".video-recorder-dialog__camera-overlay",
    ) as HTMLDivElement;
    expect(overlay).not.toBeNull();

    fireEvent.pointerDown(overlay, {
      button: 0,
      clientX: 100,
      clientY: 100,
    });
    fireEvent.pointerCancel(window);
    fireEvent.pointerMove(window, {
      clientX: 230,
      clientY: 180,
    });

    expect(onCameraLayoutChange).toHaveBeenCalledTimes(0);
  });

  it("clears drag interaction on pointerup without pointer id", () => {
    const { onCameraLayoutChange } = renderDialog({
      settings: {
        ...getDefaultVideoRecorderSettings(),
        cameraEnabled: true,
      },
    });

    const preview = document.querySelector(
      ".video-recorder-dialog__preview",
    ) as HTMLDivElement;
    expect(preview).not.toBeNull();
    vi.spyOn(preview, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 1000,
      bottom: 500,
      width: 1000,
      height: 500,
      toJSON: () => ({}),
    } as DOMRect);

    const overlay = document.querySelector(
      ".video-recorder-dialog__camera-overlay",
    ) as HTMLDivElement;
    expect(overlay).not.toBeNull();

    fireEvent.pointerDown(overlay, {
      pointerId: 1,
      button: 0,
      clientX: 100,
      clientY: 100,
    });
    fireEvent.pointerUp(window);
    fireEvent.pointerMove(window, {
      pointerId: 1,
      clientX: 220,
      clientY: 180,
    });

    expect(onCameraLayoutChange).toHaveBeenCalledTimes(0);
  });

  it("stops active drag when camera gets disabled", () => {
    const onCameraLayoutChange = vi.fn();
    const onRefreshDevices = vi.fn(async () => undefined);
    const onRequestPermissions = vi.fn(async () => undefined);
    const onStart = vi.fn(async () => undefined);
    const onSettingsChange = vi.fn();
    const enabledSettings = {
      ...getDefaultVideoRecorderSettings(),
      cameraEnabled: true,
    };
    const disabledSettings = {
      ...enabledSettings,
      cameraEnabled: false,
    };

    const { rerender } = renderDialog({
      settings: enabledSettings,
      onCameraLayoutChange,
      onRefreshDevices,
      onRequestPermissions,
      onStart,
    });

    const preview = document.querySelector(
      ".video-recorder-dialog__preview",
    ) as HTMLDivElement;
    expect(preview).not.toBeNull();
    vi.spyOn(preview, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 1000,
      bottom: 500,
      width: 1000,
      height: 500,
      toJSON: () => ({}),
    } as DOMRect);

    const overlay = document.querySelector(
      ".video-recorder-dialog__camera-overlay",
    ) as HTMLDivElement;
    expect(overlay).not.toBeNull();
    fireEvent.pointerDown(overlay, {
      button: 0,
      clientX: 100,
      clientY: 100,
    });

    rerender(
      <EditorJotaiProvider>
        <UIAppStateContext.Provider value={getUIAppState()}>
          <VideoRecorderDialog
            isOpen={true}
            capabilities={{
              isSupported: true,
              supportedMimeTypes: ["video/webm"],
            }}
            status="idle"
            error={null}
            settings={disabledSettings}
            devices={{ videoInputs: [], audioInputs: [] }}
            onClose={vi.fn()}
            onRefreshDevices={onRefreshDevices}
            onStart={onStart}
            onRequestPermissions={onRequestPermissions}
            isRequestingPermissions={false}
            onSettingsChange={onSettingsChange}
            onCameraLayoutChange={onCameraLayoutChange}
          />
        </UIAppStateContext.Provider>
      </EditorJotaiProvider>,
    );

    fireEvent.pointerMove(window, {
      clientX: 250,
      clientY: 180,
    });
    fireEvent.pointerUp(window);

    expect(onCameraLayoutChange).toHaveBeenCalledTimes(0);
  });
});
