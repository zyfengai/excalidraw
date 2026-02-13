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

vi.mock("@excalidraw/excalidraw/i18n", () => {
  const dictionary: Record<string, string> = {
    "videoRecorder.title": "Video recorder",
    "videoRecorder.actions.requestPermissions":
      "Enable camera & microphone access",
    "videoRecorder.camera.shape": "Camera shape",
    "videoRecorder.camera.sizeWidth": "Camera width",
    "videoRecorder.camera.sizeHeight": "Camera height",
    "videoRecorder.camera.resetLayout": "Reset camera position & size",
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
  }> = {},
) => {
  const onCameraLayoutChange = opts.onCameraLayoutChange ?? vi.fn();
  const onRequestPermissions = opts.onRequestPermissions ?? vi.fn();

  const settings = opts.settings ?? {
    ...getDefaultVideoRecorderSettings(),
    cameraEnabled: true,
  };

  render(
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
          onRefreshDevices={vi.fn(async () => undefined)}
          onStart={vi.fn(async () => undefined)}
          onRequestPermissions={onRequestPermissions}
          isRequestingPermissions={false}
          onSettingsChange={vi.fn()}
          onCameraLayoutChange={onCameraLayoutChange}
        />
      </UIAppStateContext.Provider>
    </EditorJotaiProvider>,
  );

  return {
    onCameraLayoutChange,
    onRequestPermissions,
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
});
