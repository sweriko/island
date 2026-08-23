import "./style.css";

import { App } from "./app";

function showFatalError(container: HTMLElement, error: unknown): void {
  const card = document.createElement("section");
  card.className = "error-card";

  const title = card.appendChild(document.createElement("h1"));
  title.className = "error-card__title";
  title.textContent = "Renderer initialisation failed";

  const message = card.appendChild(document.createElement("p"));
  message.className = "error-card__message";
  message.textContent = error instanceof Error ? error.message : String(error);

  container.replaceChildren(card);
}

const container = document.querySelector<HTMLElement>("#app");

if (!container) throw new Error("App root #app was not found.");

const app = new App(container);

app.init().catch((error: unknown) => {
  console.error(error);
  showFatalError(container, error);
});

import.meta.hot?.dispose(() => app.dispose());
