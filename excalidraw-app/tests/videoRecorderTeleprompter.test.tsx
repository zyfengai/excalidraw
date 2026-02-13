import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { VideoRecorderTeleprompter } from "../components/video-recorder/VideoRecorderTeleprompter";

type RafCallbackMap = Map<number, FrameRequestCallback>;

const installRafMock = () => {
  const callbacks: RafCallbackMap = new Map();
  let rafId = 0;

  const requestAnimationFrameSpy = vi
    .spyOn(window, "requestAnimationFrame")
    .mockImplementation((callback: FrameRequestCallback) => {
      rafId += 1;
      callbacks.set(rafId, callback);
      return rafId;
    });

  const cancelAnimationFrameSpy = vi
    .spyOn(window, "cancelAnimationFrame")
    .mockImplementation((id: number) => {
      callbacks.delete(id);
    });

  const runNextFrame = (timestamp: number) => {
    const [id, callback] = callbacks.entries().next().value || [];
    if (!id || !callback) {
      return;
    }
    callbacks.delete(id);
    callback(timestamp);
  };

  return {
    runNextFrame,
    requestAnimationFrameSpy,
    cancelAnimationFrameSpy,
  };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("VideoRecorderTeleprompter", () => {
  it("does not render for empty text", () => {
    const { container } = render(
      <VideoRecorderTeleprompter
        text="   "
        speed={50}
        opacity={0.6}
        running={true}
      />,
    );

    expect(container.firstChild).toBeNull();
  });

  it("renders trimmed lines, floating class, and clamped opacity", () => {
    const { container } = render(
      <VideoRecorderTeleprompter
        text={"  line one \n\n line two  "}
        speed={50}
        opacity={5}
        running={false}
        floating
      />,
    );

    const root = container.querySelector(".video-recorder-teleprompter");
    expect(root).toBeTruthy();
    expect(root).toHaveClass("video-recorder-teleprompter--floating");
    expect(root).toHaveStyle({ "--teleprompter-opacity": "1" });

    const paragraphs = [...container.querySelectorAll("p")].map(
      (node) => node.textContent,
    );
    expect(paragraphs).toEqual(["line one", "line two"]);
  });

  it("updates offset with animation frames and resets on text change", () => {
    const { runNextFrame } = installRafMock();

    const { container, rerender } = render(
      <VideoRecorderTeleprompter
        text="hello"
        speed={40}
        opacity={0.5}
        running={true}
      />,
    );

    const content = () =>
      container.querySelector(
        ".video-recorder-teleprompter__content",
      ) as HTMLDivElement;

    act(() => runNextFrame(1000));
    expect(content().style.transform).toBe("translateY(0px)");

    act(() => runNextFrame(2000));
    expect(content().style.transform).toBe("translateY(-40px)");

    rerender(
      <VideoRecorderTeleprompter
        text="new text"
        speed={40}
        opacity={0.5}
        running={true}
      />,
    );

    expect(content().style.transform).toBe("translateY(0px)");
  });

  it("stops scheduling frames when running becomes false", () => {
    const { runNextFrame, requestAnimationFrameSpy, cancelAnimationFrameSpy } =
      installRafMock();

    const { container, rerender } = render(
      <VideoRecorderTeleprompter
        text="line"
        speed={30}
        opacity={0.7}
        running={true}
      />,
    );

    const content = () =>
      container.querySelector(
        ".video-recorder-teleprompter__content",
      ) as HTMLDivElement;

    act(() => runNextFrame(1000));
    act(() => runNextFrame(2000));
    const callCountBeforePause = requestAnimationFrameSpy.mock.calls.length;
    const transformBeforePause = content().style.transform;

    rerender(
      <VideoRecorderTeleprompter
        text="line"
        speed={30}
        opacity={0.7}
        running={false}
      />,
    );

    act(() => runNextFrame(3000));

    expect(cancelAnimationFrameSpy).toHaveBeenCalledTimes(1);
    expect(content().style.transform).toBe(transformBeforePause);
    expect(requestAnimationFrameSpy.mock.calls.length).toBe(
      callCountBeforePause,
    );
  });

  it("cancels pending animation frame on unmount", () => {
    const { cancelAnimationFrameSpy } = installRafMock();

    const { unmount } = render(
      <VideoRecorderTeleprompter
        text="line"
        speed={30}
        opacity={0.7}
        running={true}
      />,
    );

    unmount();

    expect(cancelAnimationFrameSpy).toHaveBeenCalledTimes(1);
  });

  it("continues scrolling from previous offset after pause and resume", () => {
    const { runNextFrame } = installRafMock();

    const { container, rerender } = render(
      <VideoRecorderTeleprompter
        text="line"
        speed={40}
        opacity={0.7}
        running={true}
      />,
    );

    const content = () =>
      container.querySelector(
        ".video-recorder-teleprompter__content",
      ) as HTMLDivElement;

    act(() => runNextFrame(1000));
    act(() => runNextFrame(2000));
    expect(content().style.transform).toBe("translateY(-40px)");

    rerender(
      <VideoRecorderTeleprompter
        text="line"
        speed={40}
        opacity={0.7}
        running={false}
      />,
    );

    rerender(
      <VideoRecorderTeleprompter
        text="line"
        speed={40}
        opacity={0.7}
        running={true}
      />,
    );

    act(() => runNextFrame(3000));
    expect(content().style.transform).toBe("translateY(-40px)");

    act(() => runNextFrame(4000));
    expect(content().style.transform).toBe("translateY(-80px)");
  });
});
