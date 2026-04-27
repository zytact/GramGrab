import "./styles.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Popup root missing");
}

root.innerHTML = `
  <div class="container">
    <header>InstaSave</header>
    <p class="hint">Instagram post, reel, story, or highlight URL</p>
    <div class="input-group">
      <input id="ig-url" type="url" placeholder="Paste URL or auto-detected from tab" />
    </div>
    <div class="row">
      <button id="fetch-btn" type="button">Fetch Media</button>
    </div>
    <div id="media-list" class="media-list"></div>
    <div class="row">
      <button id="download-selected-btn" type="button" disabled>Download Selected</button>
    </div>
    <p id="status" class="msg info">Ready.</p>
  </div>
`;

const input = document.getElementById("ig-url") as HTMLInputElement;
const fetchButton = document.getElementById("fetch-btn") as HTMLButtonElement;
const downloadSelectedButton = document.getElementById("download-selected-btn") as HTMLButtonElement;
const mediaList = document.getElementById("media-list") as HTMLDivElement;
const status = document.getElementById("status") as HTMLParagraphElement;

let mediaItems: { index: number; type: string; url: string; filenameHint: string; selected: boolean; previewUrl?: string }[] = [];
let previewCleanup: string[] = [];

// Auto-detect URL from active tab
browser.tabs?.query({ active: true, currentWindow: true }).then((tabs) => {
  const active = tabs[0];
  const url = active?.url ?? "";
  if (url.includes("instagram.com")) {
    input.value = url;
    status.className = "msg info";
    status.textContent = "Instagram URL detected. Click Fetch Media.";
  }
}).catch(() => {
  // Ignore errors
});

function renderMediaList() {
  previewCleanup.forEach((url) => URL.revokeObjectURL(url));
  previewCleanup = [];

  if (mediaItems.length === 0) {
    mediaList.innerHTML = "<p class='hint'>No media found.</p>";
    downloadSelectedButton.disabled = true;
    return;
  }

  mediaList.innerHTML = mediaItems.map((item, i) => `
    <label class="media-item">
      <input type="checkbox" data-index="${i}" ${item.selected ? "checked" : ""} />
      <div class="media-preview">
        ${item.type === "image" 
          ? `<img data-preview-index="${i}" alt="Preview" />` 
          : `<video src="${item.url}" muted playsinline></video><div class="play-icon">▶</div>`}
      </div>
      <div class="media-info">
        <span class="media-type">${item.type}</span>
        <span class="media-hint">${item.filenameHint}</span>
      </div>
    </label>
  `).join("");

  // Add event listeners to checkboxes
  mediaList.querySelectorAll<HTMLInputElement>("input[type='checkbox']").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      const idx = parseInt(checkbox.dataset.index!);
      mediaItems[idx].selected = checkbox.checked;
      updateDownloadButton();
    });
  });

  mediaList.querySelectorAll<HTMLImageElement>("[data-preview-index]").forEach((el) => {
    const idx = parseInt(el.getAttribute("data-preview-index")!);
    const item = mediaItems[idx];
    void loadPreview(el, item);
  });

  // Select all by default
  mediaItems.forEach((item) => (item.selected = true));
  updateDownloadButton();
}

async function loadPreview(el: HTMLImageElement, item: { url: string; type: string; previewUrl?: string }) {
  try {
    const res = await browser.runtime.sendMessage({ type: "GET_PREVIEW_URL", url: item.url });
    if (res?.previewUrl) {
      previewCleanup.push(res.previewUrl);
      item.previewUrl = res.previewUrl;
      el.src = res.previewUrl;
    } else {
      el.alt = "Preview unavailable";
    }
  } catch {
    el.alt = "Preview unavailable";
  }
}

function updateDownloadButton() {
  const selectedCount = mediaItems.filter((m) => m.selected).length;
  downloadSelectedButton.disabled = selectedCount === 0;
  downloadSelectedButton.textContent = selectedCount > 0
    ? `Download Selected (${selectedCount})`
    : "Download Selected";
}

fetchButton.addEventListener("click", async () => {
  const url = input.value.trim();
  if (!url) {
    status.className = "msg error";
    status.textContent = "No URL provided.";
    return;
  }

  status.className = "msg info";
  status.textContent = "Fetching media...";
  fetchButton.disabled = true;

  try {
    const res = await browser.runtime.sendMessage({ type: "FETCH_MEDIA", url });
    if (res?.error) {
      status.className = "msg error";
      status.textContent = res.error;
      fetchButton.disabled = false;
      return;
    }

    const items = res?.media ?? [];
    mediaItems = items.map((item: { url: string; type: string; filenameHint: string }, i: number) => ({
      index: i,
      type: item.type,
      url: item.url,
      filenameHint: item.filenameHint,
      selected: true,
    }));

    renderMediaList();

    status.className = mediaItems.length > 0 ? "msg success" : "msg error";
    status.textContent = mediaItems.length > 0
      ? `Found ${mediaItems.length} item(s). Select and download.`
      : "No downloadable media found.";
  } catch (err) {
    status.className = "msg error";
    status.textContent = String(err);
  } finally {
    fetchButton.disabled = false;
  }
});

downloadSelectedButton.addEventListener("click", async () => {
  const selected = mediaItems.filter((m) => m.selected);
  if (selected.length === 0) {
    status.className = "msg error";
    status.textContent = "No items selected.";
    return;
  }

  status.className = "msg info";
  status.textContent = `Downloading ${selected.length} item(s)...`;
  downloadSelectedButton.disabled = true;

  try {
    const urls = selected.map((m) => m.url);
    const hints = selected.map((m) => m.filenameHint);
    const types = selected.map((m) => m.type);

    const res = await browser.runtime.sendMessage({
      type: "DOWNLOAD_MEDIA",
      urls,
      hints,
      types,
    });

    if (res?.error) {
      status.className = "msg error";
      status.textContent = res.error;
      return;
    }

    status.className = "msg success";
    status.textContent = `Downloaded ${selected.length} item(s).`;
  } catch (err) {
    status.className = "msg error";
    status.textContent = String(err);
  } finally {
    downloadSelectedButton.disabled = false;
  }
});
