import type { Config } from "tailwindcss";
import typography from "@tailwindcss/typography";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        ink: "#07111f",
        panel: "rgba(15, 23, 42, 0.72)",
        line: "rgba(148, 163, 184, 0.22)",
        bull: "#21d07a",
        bear: "#ff5d73",
      },
      boxShadow: {
        glow: "0 0 60px rgba(45, 212, 191, 0.18)",
      },
    },
  },
  plugins: [typography],
};

export default config;
