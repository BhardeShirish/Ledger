/** "The Counter Book" — warm ledger paper, ink, one turmeric accent. */
import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        paper: {
          DEFAULT: "#FAF7F2",
          2: "#F3EEE6",
          3: "#ECE5DA",
        },
        ink: {
          DEFAULT: "#1C1917",
          soft: "#57534E",
          faint: "#A8A29E",
        },
        accent: {
          DEFAULT: "#C2410C",   // burnt turmeric — actions & highlights only
          soft: "#FFF1E7",
        },
        good: "#15803D",
        bad: "#B91C1C",
        rule: { DEFAULT: "#E7E0D8", strong: "#D6CCC0" },
      },
      fontFamily: {
        sans: ['"IBM Plex Sans"', "system-ui", "sans-serif"],
        mono: ['"IBM Plex Mono"', "ui-monospace", "monospace"],
      },
      fontSize: {
        figure: ["0.9375rem", { lineHeight: "1.4" }],
      },
      boxShadow: {
        sheet: "0 12px 40px -12px rgba(28,25,23,.28)",
      },
    },
  },
  plugins: [],
} satisfies Config;
