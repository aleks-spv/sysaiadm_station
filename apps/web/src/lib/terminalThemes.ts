// Terminal color schemes for the terminal plugin (xterm ITheme fields). "app" is built from the UI theme at runtime.
export interface TerminalPalette {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

type Ansi = Omit<TerminalPalette, "background" | "foreground" | "cursor" | "selectionBackground">;

const ansi = (c: string[]): Ansi => {
  const [black, red, green, yellow, blue, magenta, cyan, white, brightBlack, brightRed, brightGreen, brightYellow, brightBlue, brightMagenta, brightCyan, brightWhite] = c as [
    string, string, string, string, string, string, string, string, string, string, string, string, string, string, string, string,
  ];
  return { black, red, green, yellow, blue, magenta, cyan, white, brightBlack, brightRed, brightGreen, brightYellow, brightBlue, brightMagenta, brightCyan, brightWhite };
};

export const TERMINAL_THEMES: Array<{ id: string; label: string; palette: TerminalPalette | null }> = [
  { id: "app", label: "", palette: null },
  {
    id: "one-dark",
    label: "One Dark",
    palette: { background: "#282c34", foreground: "#abb2bf", cursor: "#528bff", selectionBackground: "#3e4451",
      ...ansi(["#282c34", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#abb2bf", "#5c6370", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#ffffff"]) },
  },
  {
    id: "tokyo-night",
    label: "Tokyo Night",
    palette: { background: "#1a1b26", foreground: "#c0caf5", cursor: "#c0caf5", selectionBackground: "#33467c",
      ...ansi(["#15161e", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#a9b1d6", "#414868", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#c0caf5"]) },
  },
  {
    id: "dracula",
    label: "Dracula",
    palette: { background: "#282a36", foreground: "#f8f8f2", cursor: "#f8f8f2", selectionBackground: "#44475a",
      ...ansi(["#21222c", "#ff5555", "#50fa7b", "#f1fa8c", "#bd93f9", "#ff79c6", "#8be9fd", "#f8f8f2", "#6272a4", "#ff6e6e", "#69ff94", "#ffffa5", "#d6acff", "#ff92df", "#a4ffff", "#ffffff"]) },
  },
  {
    id: "catppuccin",
    label: "Catppuccin Mocha",
    palette: { background: "#1e1e2e", foreground: "#cdd6f4", cursor: "#f5e0dc", selectionBackground: "#45475a",
      ...ansi(["#45475a", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#f5c2e7", "#94e2d5", "#bac2de", "#585b70", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#f5c2e7", "#94e2d5", "#a6adc8"]) },
  },
  {
    id: "gruvbox",
    label: "Gruvbox Dark",
    palette: { background: "#282828", foreground: "#ebdbb2", cursor: "#ebdbb2", selectionBackground: "#504945",
      ...ansi(["#282828", "#cc241d", "#98971a", "#d79921", "#458588", "#b16286", "#689d6a", "#a89984", "#928374", "#fb4934", "#b8bb26", "#fabd2f", "#83a598", "#d3869b", "#8ec07c", "#ebdbb2"]) },
  },
  {
    id: "nord",
    label: "Nord",
    palette: { background: "#2e3440", foreground: "#d8dee9", cursor: "#d8dee9", selectionBackground: "#434c5e",
      ...ansi(["#3b4252", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#88c0d0", "#e5e9f0", "#4c566a", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#8fbcbb", "#eceff4"]) },
  },
  {
    id: "solarized-dark",
    label: "Solarized Dark",
    palette: { background: "#002b36", foreground: "#839496", cursor: "#93a1a1", selectionBackground: "#073642",
      ...ansi(["#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#eee8d5", "#586e75", "#cb4b16", "#859900", "#b58900", "#268bd2", "#6c71c4", "#2aa198", "#fdf6e3"]) },
  },
  {
    id: "matrix",
    label: "Matrix",
    palette: { background: "#0a0f0a", foreground: "#4af626", cursor: "#4af626", selectionBackground: "#1f3d1f",
      ...ansi(["#0a0f0a", "#e05050", "#4af626", "#c8e64a", "#3fb950", "#7ee787", "#56d364", "#b6f2a8", "#2d4a2d", "#ff7b72", "#7ee787", "#e3f56e", "#56d364", "#a5f3a0", "#8ff58a", "#e6ffe0"]) },
  },
  {
    id: "github-light",
    label: "GitHub Light",
    palette: { background: "#ffffff", foreground: "#1f2328", cursor: "#0969da", selectionBackground: "#b6e3ff",
      ...ansi(["#24292f", "#cf222e", "#116329", "#4d2d00", "#0969da", "#8250df", "#1b7c83", "#6e7781", "#57606a", "#a40e26", "#1a7f37", "#633c01", "#218bff", "#a475f9", "#3192aa", "#8c959f"]) },
  },
  {
    id: "solarized-light",
    label: "Solarized Light",
    palette: { background: "#fdf6e3", foreground: "#657b83", cursor: "#586e75", selectionBackground: "#eee8d5",
      ...ansi(["#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#eee8d5", "#002b36", "#cb4b16", "#586e75", "#657b83", "#839496", "#6c71c4", "#93a1a1", "#fdf6e3"]) },
  },
];

// ANSI colors for the "app" scheme, so ls/systemctl output is colored there too.
export const APP_ANSI_DARK = ansi(["#3a3633", "#f07178", "#a6cc70", "#ffcc66", "#73b8ff", "#d4a6ff", "#5ccfe6", "#cbccc6", "#6b6560", "#ff8f8f", "#bae67e", "#ffd580", "#8fc8ff", "#e2b8ff", "#95e6cb", "#ffffff"]);
export const APP_ANSI_LIGHT = ansi(["#3a3633", "#c4303f", "#3d7a1c", "#9a6700", "#1f6fd1", "#8a3fd1", "#167a8a", "#6b6560", "#57534e", "#d9455a", "#4c9a24", "#b07d00", "#3a85e0", "#9c55e0", "#1f93a6", "#8a847e"]);

export function terminalPalette(id: string): TerminalPalette | null {
  return TERMINAL_THEMES.find((th) => th.id === id)?.palette ?? null;
}
