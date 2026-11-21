// Renders the app's icon (electron/icon.svg) to the PNG the window uses.
import sharp from "sharp";
await sharp("electron/icon.svg", { density: 144 }).resize(512, 512).png().toFile("electron/icon.png");
console.log("electron/icon.png");
