import { fileURLToPath } from "node:url";

export default {
  plugins: {
    "@csstools/postcss-global-data": {
      files: [fileURLToPath(new URL("./src/ui/themes/styles/media.css", import.meta.url))],
    },
    "postcss-custom-media": {},
    "postcss-nesting": {},
    autoprefixer: {},
  },
};
