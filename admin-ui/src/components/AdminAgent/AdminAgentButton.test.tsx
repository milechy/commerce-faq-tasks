import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import AdminAgentButton from "./AdminAgentButton";

describe("AdminAgentButton — 未読バッジ", () => {
  it("hasUnread=false ではバッジを表示しない", () => {
    render(<AdminAgentButton onClick={vi.fn()} isOpen={false} hasUnread={false} />);
    const button = screen.getByRole("button");
    expect(button.querySelector("span")).toBeNull();
  });

  it("hasUnread=true かつ閉じている場合はバッジを表示する", () => {
    render(<AdminAgentButton onClick={vi.fn()} isOpen={false} hasUnread={true} />);
    const button = screen.getByRole("button");
    expect(button.querySelector("span")).not.toBeNull();
  });

  it("パネルが開いている間はバッジを表示しない", () => {
    render(<AdminAgentButton onClick={vi.fn()} isOpen={true} hasUnread={true} />);
    const button = screen.getByRole("button");
    expect(button.querySelector("span")).toBeNull();
  });
});
