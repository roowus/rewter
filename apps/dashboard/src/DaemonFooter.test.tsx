/**
 * The footer, clicked.
 *
 * The claim under test is not "the button posts" — it is that the button does
 * *not* post until it has been confirmed, and that once it has, it never posts
 * again. Between them those are the whole safety story of a control that ends
 * the process serving the page.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonFooter } from "./DaemonFooter.js";

const ACCEPTED = {
  ok: true,
  pid: 4242,
  supervisor: "launchd",
  willRestart: false,
  restartWith: "launchctl kickstart gui/$(id -u)/com.roowus.rewter",
};

const accepts = (body: unknown = ACCEPTED, status = 202) =>
  vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );

afterEach(cleanup);

describe("DaemonFooter", () => {
  it("says where the data lives, and that keys are not part of it", () => {
    // The line exists because every other panel on this page looks like a
    // hosted control plane, and nothing else says otherwise.
    render(<DaemonFooter version="0.1.0" fetchImpl={accepts() as unknown as typeof fetch} />);
    expect(screen.getByText(/Local Mode/)).toBeDefined();
    expect(screen.getByText(/read from your environment by name, never saved/)).toBeDefined();
    expect(screen.getByText(/v0\.1\.0/)).toBeDefined();
  });

  it("omits the version entirely rather than showing a placeholder for it", () => {
    // Health has not answered yet on first paint. "v—" or "vunknown" in a
    // footer reads as a version the daemon reported, which it did not.
    render(<DaemonFooter version={null} fetchImpl={accepts() as unknown as typeof fetch} />);
    const notice = screen.getByText(/Local Mode/);
    expect(notice.textContent).not.toMatch(/·\s*v/);
    // And the rest of the sentence is still there — the whole line does not
    // wait on a version it does not need.
    expect(notice.textContent).toContain("stores everything here");
  });

  it("posts nothing on the first click — it arms a confirmation", () => {
    // The misclick case, and the entire reason the control has two steps: this
    // button kills the process rendering the page.
    const fetchImpl = accepts();
    render(<DaemonFooter version="0.1.0" fetchImpl={fetchImpl as unknown as typeof fetch} />);

    fireEvent.click(screen.getByText("Shut down"));

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toBeDefined();
  });

  it("names the consequences in the confirmation, including that nothing restarts it", () => {
    render(<DaemonFooter version="0.1.0" fetchImpl={accepts() as unknown as typeof fetch} />);
    fireEvent.click(screen.getByText("Shut down"));

    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("Running tasks are cut off");
    expect(dialog.textContent).toContain("nothing on this machine will start it again");
  });

  it("puts the button back, unfired, when the confirmation is cancelled", () => {
    const fetchImpl = accepts();
    render(<DaemonFooter version="0.1.0" fetchImpl={fetchImpl as unknown as typeof fetch} />);

    fireEvent.click(screen.getByText("Shut down"));
    fireEvent.click(screen.getByText("Cancel"));

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(screen.getByText("Shut down")).toBeDefined();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("posts once confirmed, and reports the daemon's own restart advice", async () => {
    const fetchImpl = accepts();
    render(<DaemonFooter version="0.1.0" fetchImpl={fetchImpl as unknown as typeof fetch} />);

    fireEvent.click(screen.getByText("Shut down"));
    fireEvent.click(screen.getByText("Yes, shut down"));

    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/internal/shutdown");
    expect(init.method).toBe("POST");

    // The command comes from the daemon, which knows what started it; the
    // dashboard is not in a position to guess it.
    await screen.findByText(/launchctl kickstart/);
  });

  it("does not offer the button again once a shutdown was accepted", async () => {
    // A second POST would land on a socket that is already draining and come
    // back looking like the first one failed.
    const fetchImpl = accepts();
    render(<DaemonFooter version="0.1.0" fetchImpl={fetchImpl as unknown as typeof fetch} />);

    fireEvent.click(screen.getByText("Shut down"));
    fireEvent.click(screen.getByText("Yes, shut down"));

    await screen.findByText(/launchctl kickstart/);
    expect(screen.queryByText("Shut down")).toBeNull();
    expect(screen.queryByText("Yes, shut down")).toBeNull();
  });

  it("treats a connection that died mid-request as the shutdown succeeding", async () => {
    // The daemon beating its own reply across the socket. Rendering "daemon
    // unreachable" here would be true and useless.
    const dead = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    render(<DaemonFooter version="0.1.0" fetchImpl={dead as unknown as typeof fetch} />);

    fireEvent.click(screen.getByText("Shut down"));
    fireEvent.click(screen.getByText("Yes, shut down"));

    await screen.findByText(/closed before it answered/);
  });

  it("offers a way back when the daemon has no shutdown hook", async () => {
    // 501 is not a failed shutdown, it is a daemon that cannot do this — so the
    // control returns to its resting state rather than staying spent.
    const fetchImpl = accepts({ error: { message: "no hook" } }, 501);
    render(<DaemonFooter version="0.1.0" fetchImpl={fetchImpl as unknown as typeof fetch} />);

    fireEvent.click(screen.getByText("Shut down"));
    fireEvent.click(screen.getByText("Yes, shut down"));

    await screen.findByText(/use `rewter stop`/);
    fireEvent.click(screen.getByText("back"));
    expect(screen.getByText("Shut down")).toBeDefined();
  });
});
