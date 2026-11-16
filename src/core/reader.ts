export interface ModernReaderChapter {
  id: string;
  idx: number;
  title: string;
}

export interface ModernReaderOptions {
  projectTitle: string;
  chapter: ModernReaderChapter;
  allChapters?: ModernReaderChapter[];
  prevChapter?: ModernReaderChapter | null;
  nextChapter?: ModernReaderChapter | null;
  pagesHtml: string[];
  isStrip?: boolean;
  hasPdf?: boolean;
  fallbackWidth?: number;
}

function htmlEscape(text: string): string {
  return text.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

function cleanChapterHeading(title: string): string {
  let cleaned = title.replace(/^#+\s*/, "").trim();
  cleaned = cleaned.replace(/^第\s*[0-9零一二三四五六七八九十百千]+\s*章\s*/, "").trim();
  return cleaned || title.replace(/^#+\s*/, "").trim();
}

export function renderModernReader(options: ModernReaderOptions): string {
  const {
    projectTitle,
    chapter,
    allChapters = [chapter],
    prevChapter = null,
    nextChapter = null,
    pagesHtml,
    isStrip = false,
    hasPdf = false,
    fallbackWidth = 780,
  } = options;

  const pureTitle = cleanChapterHeading(chapter.title);
  const chapterList = allChapters.length > 0 ? allChapters : [chapter];
  const currentIndex = chapterList.findIndex((c) => c.id === chapter.id);
  const resolvedPrev = prevChapter ?? (currentIndex > 0 ? chapterList[currentIndex - 1] : null);
  const resolvedNext = nextChapter ?? (currentIndex >= 0 && currentIndex < chapterList.length - 1 ? chapterList[currentIndex + 1] : null);

  const allChaptersJson = JSON.stringify(
    chapterList.map((c) => ({
      id: c.id,
      idx: c.idx,
      title: cleanChapterHeading(c.title),
    }))
  );

  const drawerItems = chapterList
    .map(
      (c) => `
      <a href="../${c.id}/" class="drawer-item ${c.id === chapter.id ? "active" : ""}">
        <span class="d-num">${String(c.idx).padStart(2, "0")}</span>
        <span class="d-title">${htmlEscape(cleanChapterHeading(c.title))}</span>
      </a>`
    )
    .join("\n");

  return `<!doctype html>
<html lang="zh-CN" data-theme="dark">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=5, viewport-fit=cover">
  <title>${htmlEscape(projectTitle)} · ${htmlEscape(pureTitle)} (第 ${chapter.idx} 章)</title>
  <script>
    (function() {
      var savedTheme = localStorage.getItem('comic-theme') || (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
      document.documentElement.setAttribute('data-theme', savedTheme);
      var adaptive = localStorage.getItem('comic-adaptive') === 'true';
      if (adaptive) document.documentElement.classList.add('adaptive-mode');
    })();
  </script>
  <style>
    :root, [data-theme="dark"] {
      --bg: #090b0e;
      --bg-card: #13171f;
      --border: rgba(255, 255, 255, 0.08);
      --border-strong: rgba(255, 255, 255, 0.16);
      --accent: #00e5ff;
      --accent-glow: rgba(0, 229, 255, 0.25);
      --text-main: #f0f6fc;
      --text-sub: #8b949e;
      --nav-bg: rgba(9, 11, 14, 0.88);
      --modal-bg: #11151d;
      --manga-bg: #000000;
      --btn-sec-bg: rgba(255, 255, 255, 0.06);
      --btn-sec-hover: rgba(255, 255, 255, 0.12);
      --btn-sec-text: #e6edf3;
      --shadow-color: rgba(0, 0, 0, 0.7);
      --reader-max-width: ${Math.min(fallbackWidth, 780)}px;
    }

    [data-theme="light"] {
      --bg: #f6f8fa;
      --bg-card: #ffffff;
      --border: rgba(0, 0, 0, 0.1);
      --border-strong: rgba(0, 0, 0, 0.2);
      --accent: #0077cc;
      --accent-glow: rgba(0, 119, 204, 0.15);
      --text-main: #1f2328;
      --text-sub: #656d76;
      --nav-bg: rgba(246, 248, 250, 0.88);
      --modal-bg: #ffffff;
      --manga-bg: #e1e4e8;
      --btn-sec-bg: rgba(0, 0, 0, 0.05);
      --btn-sec-hover: rgba(0, 0, 0, 0.1);
      --btn-sec-text: #1f2328;
      --shadow-color: rgba(0, 0, 0, 0.15);
      --reader-max-width: ${Math.min(fallbackWidth, 780)}px;
    }

    [data-theme="sepia"] {
      --bg: #f4ecdc;
      --bg-card: #eae0cd;
      --border: rgba(80, 60, 40, 0.12);
      --border-strong: rgba(80, 60, 40, 0.22);
      --accent: #9c5c24;
      --accent-glow: rgba(156, 92, 36, 0.2);
      --text-main: #2c221b;
      --text-sub: #705e4d;
      --nav-bg: rgba(244, 236, 220, 0.9);
      --modal-bg: #f0e6d2;
      --manga-bg: #dfd4bf;
      --btn-sec-bg: rgba(80, 60, 40, 0.06);
      --btn-sec-hover: rgba(80, 60, 40, 0.12);
      --btn-sec-text: #2c221b;
      --shadow-color: rgba(60, 40, 20, 0.2);
      --reader-max-width: ${Math.min(fallbackWidth, 780)}px;
    }

    html.adaptive-mode {
      --reader-max-width: 100vw;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      background-color: var(--bg);
      color: var(--text-main);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
      -webkit-font-smoothing: antialiased;
      overflow-x: hidden;
      padding-top: 54px;
      transition: background-color 0.3s ease, color 0.3s ease;
    }

    .navbar {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      width: 100%;
      z-index: 1000;
      height: 54px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 16px;
      background: var(--nav-bg);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border-bottom: 1px solid var(--border);
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.35);
      transition: background 0.3s, border-color 0.3s, transform 0.3s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.25s ease;
    }
    .nav-left, .nav-right {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .nav-right { justify-content: flex-end; }
    .nav-center {
      text-align: center;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      padding: 0 10px;
      flex: 1;
    }
    .comic-name {
      font-weight: 700;
      font-size: 15px;
      color: var(--text-main);
      letter-spacing: 0.5px;
    }
    .nav-icon-link {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      color: var(--text-sub);
      text-decoration: none;
      font-size: 13px;
      padding: 6px 10px;
      border-radius: 6px;
      transition: all 0.2s;
    }
    .nav-icon-link:hover {
      color: var(--text-main);
      background: var(--btn-sec-bg);
    }
    .chapter-badge {
      display: inline-block;
      font-size: 11px;
      font-weight: 600;
      color: var(--accent);
      background: var(--btn-sec-bg);
      border: 1px solid var(--border-strong);
      padding: 1px 8px;
      border-radius: 10px;
      margin-bottom: 2px;
      transition: all 0.2s;
    }
    .chapter-heading {
      font-size: 13.5px;
      font-weight: 500;
      color: var(--text-main);
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      transition: all 0.2s;
    }
    .icon-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 36px;
      height: 36px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: var(--btn-sec-bg);
      color: var(--text-sub);
      cursor: pointer;
      text-decoration: none;
      transition: all 0.2s;
    }
    .icon-btn:hover {
      color: var(--text-main);
      background: var(--btn-sec-hover);
      border-color: var(--border-strong);
    }
    .icon {
      width: 18px;
      height: 18px;
      fill: currentColor;
    }

    .progress-bar {
      position: fixed;
      top: 54px;
      left: 0;
      width: 0%;
      height: 3px;
      background: linear-gradient(90deg, var(--accent), #38ef7d);
      box-shadow: 0 0 10px var(--accent-glow);
      z-index: 1001;
      transition: width 0.1s ease-out, top 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    }

    .manga-wrapper {
      max-width: var(--reader-max-width);
      margin: 0 auto;
      background: var(--manga-bg);
      box-shadow: 0 0 45px var(--shadow-color);
      position: relative;
      transition: max-width 0.3s cubic-bezier(0.16, 1, 0.3, 1), background 0.3s;
    }
    body.strip .manga-wrapper {
      max-width:720px;
    }
    .strip-hint {
      font-size: 11px;
      color: var(--accent);
      margin-top: 2px;
    }
    .chapter-content {
      width: 100%;
      margin: 0;
      padding: 0;
      line-height: 0;
      font-size: 0;
    }
    #prependedChapters, #appendedChapters {
      width: 100%;
      margin: 0;
      padding: 0;
      line-height: 0;
      font-size: 0;
    }
    .manga-panel {
      width: 100%;
      margin: 0;
      padding: 0;
      line-height: 0;
      font-size: 0;
    }
    .manga-panel img,
    .chapter-content img {
      display: block;
      width: 100%;
      height: auto;
      margin: 0;
      padding: 0;
      border: 0;
      vertical-align: bottom;
      content-visibility: auto;
    }
    .chapter-content figure {
      margin: 0 0 24px;
    }
    .chapter-content figcaption {
      text-align: center;
      padding: 12px;
      font-size: 13px;
      color: var(--text-sub);
      background: var(--bg-card);
    }
    .text-page {
      box-sizing: border-box;
      min-height: 50vh;
      background: var(--bg-card);
      color: var(--text-main);
      padding: 36px 24px;
      margin-bottom: 24px;
      line-height: 1.8;
      border: 1px solid var(--border);
    }
    .text-page h2 {
      font-size: 1.15rem;
      margin-bottom: 16px;
      color: var(--accent);
    }
    .text-page.notice {
      display: grid;
      place-content: center;
      text-align: center;
      color: var(--text-sub);
      font-size: 0.9rem;
      min-height: 20vh;
    }

    .chapter-divider {
      width: 100%;
      box-sizing: border-box;
      padding: 40px 16px;
      line-height: 1.5;
      font-size: 14px;
      background: radial-gradient(circle at 50% 50%, rgba(0, 229, 255, 0.1) 0%, transparent 80%), var(--bg);
      text-align: center;
      border-top: 1px dashed var(--border-strong);
      border-bottom: 1px dashed var(--border-strong);
    }
    .divider-badge {
      display: inline-block;
      font-size: 11px;
      font-weight: 700;
      color: var(--accent);
      background: rgba(0, 229, 255, 0.12);
      border: 1px solid rgba(0, 229, 255, 0.3);
      padding: 2px 10px;
      border-radius: 12px;
      margin-bottom: 8px;
      text-transform: uppercase;
      letter-spacing: 1px;
    }
    .divider-title {
      font-size: 1.15rem;
      font-weight: 600;
      color: var(--text-main);
      margin-bottom: 4px;
    }

    .end-card {
      max-width: var(--reader-max-width);
      margin: 0 auto;
      background: var(--bg-card);
      border-top: 1px solid var(--border);
      padding: 48px 24px 60px;
      text-align: center;
      transition: max-width 0.3s, background 0.3s;
    }
    .end-symbol {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 44px;
      height: 44px;
      border-radius: 50%;
      background: var(--btn-sec-bg);
      color: var(--accent);
      font-size: 20px;
      margin-bottom: 16px;
      border: 1px solid var(--border-strong);
    }
    .end-chapter-title {
      font-size: 1.25rem;
      font-weight: 600;
      color: var(--text-main);
      margin-bottom: 6px;
    }
    .btn-group {
      display: flex;
      flex-direction: column;
      gap: 12px;
      max-width: 440px;
      margin: 20px auto;
    }
    @media (min-width: 480px) {
      .btn-group {
        flex-direction: row;
      }
    }
    .act-btn {
      flex: 1;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 13px 20px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      text-decoration: none;
      transition: all 0.2s;
    }
    .act-btn.primary {
      background: linear-gradient(135deg, #00b4d8 0%, #0077b6 100%);
      color: #fff;
      box-shadow: 0 4px 16px rgba(0, 180, 216, 0.3);
    }
    .act-btn.primary:hover {
      filter: brightness(1.15);
      transform: translateY(-1px);
    }
    .act-btn.secondary {
      background: var(--btn-sec-bg);
      color: var(--btn-sec-text);
      border: 1px solid var(--border);
    }
    .act-btn.secondary:hover {
      background: var(--btn-sec-hover);
      border-color: var(--border-strong);
    }
    .act-btn.disabled {
      background: var(--btn-sec-bg);
      color: var(--text-sub);
      opacity: 0.5;
      border: 1px solid var(--border);
      cursor: not-allowed;
    }
    .act-btn.finished {
      background: rgba(56, 239, 125, 0.12);
      color: #38ef7d;
      border: 1px solid rgba(56, 239, 125, 0.3);
      cursor: default;
    }

    .float-wrap {
      position: fixed;
      right: 20px;
      bottom: 30px;
      z-index: 990;
      display: flex;
      flex-direction: column;
      gap: 12px;
      transition: opacity 0.25s ease, transform 0.25s ease;
    }
    .float-btn {
      width: 46px;
      height: 46px;
      border-radius: 50%;
      background: var(--bg-card);
      border: 1px solid var(--border-strong);
      color: var(--text-main);
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 4px 18px var(--shadow-color);
      cursor: pointer;
      transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .float-btn:hover {
      background: var(--btn-sec-hover);
      transform: scale(1.08);
      border-color: var(--accent);
      color: var(--accent);
    }
    .scroll-top-btn {
      opacity: 0;
      visibility: hidden;
      transform: translateY(10px);
    }
    .scroll-top-btn.visible {
      opacity: 1;
      visibility: visible;
      transform: translateY(0);
    }

    .modal-mask {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.6);
      backdrop-filter: blur(4px);
      z-index: 1050;
      opacity: 0;
      visibility: hidden;
      transition: opacity 0.25s ease, visibility 0.25s ease;
    }
    .modal-mask.open {
      opacity: 1;
      visibility: visible;
    }

    .settings-modal {
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%) scale(0.95);
      width: 90%;
      max-width: 440px;
      background: var(--modal-bg);
      border: 1px solid var(--border-strong);
      border-radius: 16px;
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.6);
      z-index: 1060;
      opacity: 0;
      visibility: hidden;
      transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .settings-modal.open {
      opacity: 1;
      visibility: visible;
      transform: translate(-50%, -50%) scale(1);
    }
    .modal-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 18px 24px;
      border-bottom: 1px solid var(--border);
    }
    .modal-head h3 {
      font-size: 16px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .close-btn {
      background: none;
      border: none;
      color: var(--text-sub);
      font-size: 24px;
      cursor: pointer;
      line-height: 1;
    }
    .close-btn:hover { color: var(--text-main); }
    .settings-body {
      padding: 20px 24px 28px;
      display: flex;
      flex-direction: column;
      gap: 20px;
    }
    .setting-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
    }
    .setting-title {
      font-size: 14px;
      font-weight: 600;
      margin-bottom: 2px;
    }
    .setting-desc {
      font-size: 12px;
      color: var(--text-sub);
      line-height: 1.4;
    }
    .switch {
      position: relative;
      display: inline-block;
      width: 48px;
      height: 26px;
      flex-shrink: 0;
    }
    .switch input { opacity: 0; width: 0; height: 0; }
    .slider {
      position: absolute;
      inset: 0;
      background-color: var(--btn-sec-bg);
      border: 1px solid var(--border-strong);
      border-radius: 26px;
      cursor: pointer;
      transition: 0.25s;
    }
    .slider:before {
      position: absolute;
      content: "";
      height: 18px;
      width: 18px;
      left: 3px;
      bottom: 3px;
      background-color: #fff;
      border-radius: 50%;
      box-shadow: 0 2px 4px rgba(0,0,0,0.3);
      transition: 0.25s cubic-bezier(0.16, 1, 0.3, 1);
    }
    input:checked + .slider {
      background-color: var(--accent);
      border-color: var(--accent);
    }
    input:checked + .slider:before {
      transform: translateX(22px);
      background-color: #000;
    }
    .theme-selection {
      display: flex;
      gap: 8px;
    }
    .theme-opt-btn {
      flex: 1;
      padding: 10px 0;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: var(--btn-sec-bg);
      color: var(--text-main);
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s;
    }
    .theme-opt-btn:hover {
      border-color: var(--border-strong);
    }
    .theme-opt-btn.active {
      border-color: var(--accent);
      background: rgba(0, 229, 255, 0.12);
      color: var(--accent);
      font-weight: 600;
    }

    .drawer {
      position: fixed;
      top: 0;
      right: 0;
      bottom: 0;
      width: 85%;
      max-width: 360px;
      background: var(--modal-bg);
      border-left: 1px solid var(--border);
      z-index: 1060;
      display: flex;
      flex-direction: column;
      transform: translateX(100%);
      transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1), background 0.3s, box-shadow 0.3s ease;
      box-shadow: none;
    }
    .drawer.open {
      transform: translateX(0);
      box-shadow: -10px 0 30px rgba(0, 0, 0, 0.5);
    }
    .drawer-top {
      padding: 16px 20px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .drawer-top h3 { font-size: 15px; font-weight: 600; }
    .drawer-list {
      flex: 1;
      overflow-y: auto;
      padding: 12px 10px 40px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .drawer-item {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 14px;
      border-radius: 8px;
      color: var(--text-main);
      text-decoration: none;
      font-size: 14px;
      transition: all 0.15s;
    }
    .drawer-item:hover {
      background: var(--btn-sec-bg);
    }
    .drawer-item.active {
      background: rgba(0, 229, 255, 0.12);
      color: var(--accent);
      font-weight: 600;
    }
    .d-num {
      font-size: 12px;
      color: var(--text-sub);
      font-family: monospace;
    }
    .drawer-item.active .d-num {
      color: var(--accent);
    }
    .d-title {
      flex: 1;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }

    @media (min-width: 900px) {
      .navbar {
        opacity: 0.94;
        transform: translateY(0);
        transition: opacity 0.25s ease, transform 0.25s ease;
      }
      .navbar:hover, .navbar.hover-visible, .navbar.menu-open {
        opacity: 1;
        transform: translateY(0);
      }
      .float-wrap {
        opacity: 0.9;
        transition: opacity 0.25s ease, transform 0.25s ease;
      }
      .float-wrap:hover, .float-wrap.hover-visible, .float-wrap.menu-open {
        opacity: 1;
      }
    }

    @media (max-width: 640px) {
      body {
        padding-top: 52px;
      }
      .navbar {
        height: 52px;
        padding: 0 10px;
      }
      .comic-name {
        display: none;
      }
      .nav-icon-link {
        padding: 6px;
        width: 36px;
        height: 36px;
        justify-content: center;
      }
      .icon-btn.pdf-btn {
        display: none !important;
      }
      .nav-center {
        padding: 0 4px;
      }
      .chapter-heading {
        font-size: 13px;
        max-width: 200px;
      }
      .progress-bar {
        top: 52px;
      }
      .float-wrap .float-quick-btn {
        display: none !important;
      }
    }
  </style>
</head>
<body${isStrip ? ' class="strip" data-format="strip"' : ""}>
  <!-- 顶部常驻毛玻璃导航栏 -->
  <header class="navbar">
    <div class="nav-left">
      <a href="../../" class="nav-icon-link" title="返回项目主页">
        <svg class="icon" viewBox="0 0 24 24"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
        <span class="comic-name">${htmlEscape(projectTitle)}</span>
      </a>
    </div>

    <div class="nav-center">
      <span class="chapter-badge" id="navChapterBadge">第 ${chapter.idx} 章</span>
      <div class="chapter-heading" id="navChapterHeading">${htmlEscape(pureTitle)}</div>
      ${isStrip ? '<p class="strip-hint" style="margin:0;font-size:11px;color:var(--text-sub);">手机条漫 · 单列四格</p>' : ""}
    </div>

    <div class="nav-right">
      <button class="icon-btn" onclick="toggleSettingsModal()" title="阅读器设置（自适应全屏/无限流/主题）" aria-label="设置">
        <svg class="icon" viewBox="0 0 24 24"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>
      </button>

      <button class="icon-btn" onclick="toggleDrawer()" title="章节目录" aria-label="章节目录">
        <svg class="icon" viewBox="0 0 24 24"><path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"/></svg>
      </button>

      ${hasPdf ? `<a href="chapter.pdf" download class="icon-btn pdf-btn" title="下载本章 PDF"><svg class="icon" viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg></a>` : ""}
    </div>
  </header>

  <div class="progress-bar" id="progressBar"></div>

  <main class="manga-wrapper" id="mangaWrapper">
    <!-- 向上无限流：动态挂载更早章节 -->
    <div id="prependedChapters"></div>

    <div class="chapter-content" id="chapterContent-${chapter.id}" data-id="${chapter.id}" data-idx="${chapter.idx}" data-title="${htmlEscape(pureTitle)}">
      ${pagesHtml.join("\n")}
    </div>

    <!-- 向下无限流：动态追加后续章节 -->
    <div id="appendedChapters"></div>

    <!-- 章节结尾卡片 -->
    <footer class="end-card">
      <div class="end-symbol">✦</div>
      <div class="end-chapter-title" id="endChapterTitle">${htmlEscape(pureTitle)} · 读毕</div>
      <div class="btn-group">
        ${resolvedPrev ? `<a href="../${resolvedPrev.id}/" class="act-btn secondary" id="prevChapterBtn">&larr; 上一章 (第${resolvedPrev.idx}章)</a>` : '<span class="act-btn disabled">&larr; 已是首章</span>'}
        ${resolvedNext ? `<a href="../${resolvedNext.id}/" class="act-btn primary" id="nextChapterBtn">进入下一章 (第${resolvedNext.idx}章) &rarr;</a>` : '<span class="act-btn finished">● 终章读毕</span>'}
      </div>
      <div>
        <a href="javascript:scrollToTop()" class="act-btn secondary" style="display:inline-flex;padding:8px 16px;font-size:13px;">&uarr; 回到顶部</a>
      </div>
    </footer>
  </main>

  <!-- 右下角快捷悬浮工具组 -->
  <div class="float-wrap">
    <button class="float-btn float-quick-btn" onclick="toggleSettingsModal()" title="设置" aria-label="设置">
      <svg class="icon" viewBox="0 0 24 24"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>
    </button>
    <button class="float-btn float-quick-btn" onclick="toggleDrawer()" title="目录" aria-label="目录">
      <svg class="icon" viewBox="0 0 24 24"><path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"/></svg>
    </button>
    <button class="float-btn scroll-top-btn" id="scrollTopBtn" onclick="scrollToTop()" title="回到顶部" aria-label="回到顶部">
      <svg class="icon" viewBox="0 0 24 24"><path d="M7.41 15.41L12 10.83l4.59 4.58L18 14l-6-6-6 6z"/></svg>
    </button>
  </div>

  <div class="modal-mask" id="modalMask" onclick="closeAllModals()"></div>

  <!-- 设置弹窗 -->
  <div class="settings-modal" id="settingsModal" role="dialog" aria-modal="true" aria-labelledby="settingsTitle">
    <div class="modal-head">
      <h3 id="settingsTitle">
        <svg class="icon" viewBox="0 0 24 24"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>
        阅读器偏好设置
      </h3>
      <button class="close-btn" onclick="toggleSettingsModal()" aria-label="关闭">&times;</button>
    </div>
    <div class="settings-body">
      <div class="setting-item">
        <div class="setting-text">
          <div class="setting-title">自适应屏幕</div>
          <div class="setting-desc">电脑宽屏等比放大填满屏幕，消除两侧留白</div>
        </div>
        <label class="switch">
          <input type="checkbox" id="adaptiveSwitch" onchange="onAdaptiveChange(this.checked)">
          <span class="slider"></span>
        </label>
      </div>

      <div class="setting-item">
        <div class="setting-text">
          <div class="setting-title">双向连续阅读（无限滚动）</div>
          <div class="setting-desc">下滑自动拼入下一章，上滑无感补全上一章</div>
        </div>
        <label class="switch">
          <input type="checkbox" id="infiniteSwitch" onchange="onInfiniteChange(this.checked)">
          <span class="slider"></span>
        </label>
      </div>

      <div class="setting-item" style="flex-direction:column;align-items:flex-start;gap:8px;">
        <div class="setting-text">
          <div class="setting-title">阅读色温</div>
          <div class="setting-desc">根据光线环境随心选择底色</div>
        </div>
        <div class="theme-selection" style="width:100%;">
          <button class="theme-opt-btn" id="opt-dark" onclick="setTheme('dark')">🌙 纯夜暗黑</button>
          <button class="theme-opt-btn" id="opt-sepia" onclick="setTheme('sepia')">🍵 温润护眼</button>
          <button class="theme-opt-btn" id="opt-light" onclick="setTheme('light')">☀️ 晴空白昼</button>
        </div>
      </div>
    </div>
  </div>

  <!-- 章节目录抽屉 -->
  <aside class="drawer" id="drawer">
    <div class="drawer-top">
      <h3>${htmlEscape(projectTitle)} · 章节目录 (${chapterList.length})</h3>
      <button class="close-btn" onclick="toggleDrawer()" aria-label="关闭">&times;</button>
    </div>
    <div class="drawer-list">
      ${drawerItems}
    </div>
  </aside>

  <script>
    const ALL_CHAPTERS = ${allChaptersJson};
    let activeChapter = {
      id: "${chapter.id}",
      idx: ${chapter.idx},
      title: "${htmlEscape(pureTitle)}"
    };

    let isAdaptiveScreen = localStorage.getItem('comic-adaptive') === 'true';
    let isInfiniteScroll = localStorage.getItem('comic-infinite') !== 'false';

    document.getElementById('adaptiveSwitch').checked = isAdaptiveScreen;
    document.getElementById('infiniteSwitch').checked = isInfiniteScroll;

    function onAdaptiveChange(checked) {
      isAdaptiveScreen = checked;
      localStorage.setItem('comic-adaptive', checked ? 'true' : 'false');
      document.documentElement.classList.toggle('adaptive-mode', checked);
    }

    function onInfiniteChange(checked) {
      isInfiniteScroll = checked;
      localStorage.setItem('comic-infinite', checked ? 'true' : 'false');
    }

    const THEMES = ['dark', 'sepia', 'light'];
    function updateThemeUI(theme) {
      document.documentElement.setAttribute('data-theme', theme);
      localStorage.setItem('comic-theme', theme);
      THEMES.forEach(function(t) {
        var opt = document.getElementById('opt-' + t);
        if (opt) opt.classList.toggle('active', t === theme);
      });
    }
    function setTheme(theme) { updateThemeUI(theme); }
    updateThemeUI(document.documentElement.getAttribute('data-theme') || 'dark');

    function toggleSettingsModal() {
      var modal = document.getElementById('settingsModal');
      var mask = document.getElementById('modalMask');
      var isOpen = modal.classList.toggle('open');
      mask.classList.toggle('open', isOpen);
      if (isOpen) document.getElementById('drawer').classList.remove('open');
      syncMenuOpenState();
    }

    function toggleDrawer() {
      var drawer = document.getElementById('drawer');
      var mask = document.getElementById('modalMask');
      var isOpen = drawer.classList.toggle('open');
      mask.classList.toggle('open', isOpen);
      if (isOpen) document.getElementById('settingsModal').classList.remove('open');
      syncMenuOpenState();
    }

    function closeAllModals() {
      document.getElementById('settingsModal').classList.remove('open');
      document.getElementById('drawer').classList.remove('open');
      document.getElementById('modalMask').classList.remove('open');
      syncMenuOpenState();
    }

    function syncMenuOpenState() {
      var isAnyOpen = document.getElementById('settingsModal').classList.contains('open') ||
                        document.getElementById('drawer').classList.contains('open');
      var nav = document.querySelector('.navbar');
      var float = document.querySelector('.float-wrap');
      if (nav) nav.classList.toggle('menu-open', isAnyOpen);
      if (float) float.classList.toggle('menu-open', isAnyOpen);
    }

    // 双向无感无限流动连续阅读引擎
    let loadedChapterIndices = [${chapter.idx}];
    let isLoadingNextChapter = false;
    let isLoadingPrevChapter = false;
    let hasUserScrolled = false;
    let lastScrollY = window.scrollY || document.documentElement.scrollTop || 0;

    async function loadPrevChapterSeamlessly() {
      if (!isInfiniteScroll || isLoadingPrevChapter) return;
      var firstIdx = loadedChapterIndices[0];
      if (firstIdx <= 1) return;

      var prevMeta = ALL_CHAPTERS[firstIdx - 2];
      if (!prevMeta) return;

      isLoadingPrevChapter = true;

      try {
        var resp = await fetch('../' + prevMeta.id + '/index.html');
        if (!resp.ok) throw new Error('Fetch prev chapter failed');
        var htmlText = await resp.text();
        var parser = new DOMParser();
        var doc = parser.parseFromString(htmlText, 'text/html');
        var newItems = doc.querySelectorAll('.chapter-content > *');

        if (newItems && newItems.length > 0) {
          var prependedContainer = document.getElementById('prependedChapters');

          var chapterSection = document.createElement('div');
          chapterSection.className = 'chapter-content';
          chapterSection.id = 'chapterContent-' + prevMeta.id;
          chapterSection.dataset.id = prevMeta.id;
          chapterSection.dataset.idx = prevMeta.idx;
          chapterSection.dataset.title = prevMeta.title;

          var divider = document.createElement('div');
          divider.className = 'chapter-divider';
          divider.dataset.id = prevMeta.id;
          divider.dataset.idx = prevMeta.idx;
          divider.dataset.title = prevMeta.title;
          divider.innerHTML = '<span class="divider-badge">第 ' + prevMeta.idx + ' 章</span><div class="divider-title">' + prevMeta.title + '</div>';

          newItems.forEach(function(item) {
            var clone = item.cloneNode(true);
            var img = clone.querySelector('img') || (clone.tagName === 'IMG' ? clone : null);
            if (img) {
              var src = img.getAttribute('src');
              if (src && !src.startsWith('http') && !src.startsWith('/')) {
                img.src = '../' + prevMeta.id + '/' + src;
              }
            }
            chapterSection.appendChild(clone);
          });

          var prevScrollHeight = document.documentElement.scrollHeight;
          var prevScrollTop = window.scrollY || document.documentElement.scrollTop;

          var frag = document.createDocumentFragment();
          frag.appendChild(chapterSection);
          frag.appendChild(divider);
          prependedContainer.insertBefore(frag, prependedContainer.firstChild);

          var newScrollHeight = document.documentElement.scrollHeight;
          var heightDiff = newScrollHeight - prevScrollHeight;
          window.scrollTo({
            top: prevScrollTop + heightDiff,
            behavior: 'instant'
          });

          loadedChapterIndices.unshift(prevMeta.idx);
        }
      } catch (err) {
        console.warn('Auto load prev chapter error:', err);
      } finally {
        isLoadingPrevChapter = false;
      }
    }

    async function loadNextChapterSeamlessly() {
      if (!isInfiniteScroll || isLoadingNextChapter) return;
      var lastIdx = loadedChapterIndices[loadedChapterIndices.length - 1];
      if (lastIdx >= ALL_CHAPTERS.length) return;

      var nextMeta = ALL_CHAPTERS[lastIdx];
      if (!nextMeta) return;

      isLoadingNextChapter = true;

      try {
        var resp = await fetch('../' + nextMeta.id + '/index.html');
        if (!resp.ok) throw new Error('Fetch next chapter failed');
        var htmlText = await resp.text();
        var parser = new DOMParser();
        var doc = parser.parseFromString(htmlText, 'text/html');
        var newItems = doc.querySelectorAll('.chapter-content > *');

        if (newItems && newItems.length > 0) {
          var container = document.getElementById('appendedChapters');

          var divider = document.createElement('div');
          divider.className = 'chapter-divider';
          divider.dataset.id = nextMeta.id;
          divider.dataset.idx = nextMeta.idx;
          divider.dataset.title = nextMeta.title;
          divider.innerHTML = '<span class="divider-badge">第 ' + nextMeta.idx + ' 章</span><div class="divider-title">' + nextMeta.title + '</div>';
          container.appendChild(divider);

          var chapterSection = document.createElement('div');
          chapterSection.className = 'chapter-content';
          chapterSection.id = 'chapterContent-' + nextMeta.id;
          chapterSection.dataset.id = nextMeta.id;
          chapterSection.dataset.idx = nextMeta.idx;
          chapterSection.dataset.title = nextMeta.title;

          newItems.forEach(function(item) {
            var clone = item.cloneNode(true);
            var img = clone.querySelector('img') || (clone.tagName === 'IMG' ? clone : null);
            if (img) {
              var src = img.getAttribute('src');
              if (src && !src.startsWith('http') && !src.startsWith('/')) {
                img.src = '../' + nextMeta.id + '/' + src;
              }
            }
            chapterSection.appendChild(clone);
          });
          container.appendChild(chapterSection);

          loadedChapterIndices.push(nextMeta.idx);

          var endTitle = document.getElementById('endChapterTitle');
          if (endTitle) endTitle.textContent = nextMeta.title + ' · 读毕';
          var nextBtn = document.getElementById('nextChapterBtn');
          if (nextBtn) {
            if (nextMeta.idx < ALL_CHAPTERS.length) {
              var nextNext = ALL_CHAPTERS[nextMeta.idx];
              nextBtn.href = '../' + nextNext.id + '/';
              nextBtn.innerHTML = '进入下一章 (第' + nextNext.idx + '章) &rarr;';
            } else {
              nextBtn.outerHTML = '<span class="act-btn finished">● 终章读毕</span>';
            }
          }
        }
      } catch (err) {
        console.warn('Auto load next chapter error:', err);
      } finally {
        isLoadingNextChapter = false;
      }
    }

    window.addEventListener('wheel', function(e) {
      if (!isInfiniteScroll || isLoadingPrevChapter || loadedChapterIndices[0] <= 1) return;
      var st = document.documentElement.scrollTop || document.body.scrollTop;
      if (st <= 20 && e.deltaY < -15) {
        loadPrevChapterSeamlessly();
      }
    }, { passive: true });

    var touchStartY = 0;
    window.addEventListener('touchstart', function(e) {
      if (e.touches && e.touches.length > 0) {
        touchStartY = e.touches[0].clientY;
      }
    }, { passive: true });

    window.addEventListener('touchmove', function(e) {
      if (!isInfiniteScroll || isLoadingPrevChapter || loadedChapterIndices[0] <= 1) return;
      var st = document.documentElement.scrollTop || document.body.scrollTop;
      if (st <= 20 && e.touches && e.touches.length > 0) {
        var touchCurrentY = e.touches[0].clientY;
        if (touchCurrentY - touchStartY > 40) {
          loadPrevChapterSeamlessly();
        }
      }
    }, { passive: true });

    window.addEventListener('scroll', function() {
      var st = document.documentElement.scrollTop || document.body.scrollTop;
      var sh = document.documentElement.scrollHeight - document.documentElement.clientHeight;
      var pct = sh > 0 ? (st / sh) * 100 : 0;
      var pBar = document.getElementById('progressBar');
      if (pBar) pBar.style.width = pct + '%';

      var btn = document.getElementById('scrollTopBtn');
      if (btn) {
        if (st > 400) btn.classList.add('visible');
        else btn.classList.remove('visible');
      }

      if (st > 80) hasUserScrolled = true;
      var scrollingUp = st < lastScrollY;
      lastScrollY = st;

      if (isInfiniteScroll && (sh - st) < 1200) {
        loadNextChapterSeamlessly();
      }

      if (isInfiniteScroll && scrollingUp && hasUserScrolled && st < 500 && loadedChapterIndices[0] > 1 && !isLoadingPrevChapter) {
        loadPrevChapterSeamlessly();
      }

      detectActiveChapterInViewport();
    }, { passive: true });

    function detectActiveChapterInViewport() {
      var sections = document.querySelectorAll('.chapter-content');
      if (!sections || !sections.length) return;
      var currentSection = sections[0];
      var threshold = 160;

      sections.forEach(function(sec) {
        var rect = sec.getBoundingClientRect();
        if (rect.top <= threshold && rect.bottom > threshold) {
          currentSection = sec;
        }
      });

      if (currentSection && currentSection.dataset.id !== activeChapter.id) {
        activeChapter = {
          id: currentSection.dataset.id,
          idx: parseInt(currentSection.dataset.idx, 10),
          title: currentSection.dataset.title
        };

        var badge = document.getElementById('navChapterBadge');
        if (badge) badge.textContent = '第 ' + activeChapter.idx + ' 章';
        var heading = document.getElementById('navChapterHeading');
        if (heading) heading.textContent = activeChapter.title;
        document.title = '${htmlEscape(projectTitle)} · ' + activeChapter.title + ' (第 ' + activeChapter.idx + ' 章)';

        if (window.history && window.history.replaceState) {
          window.history.replaceState(null, '', '../' + activeChapter.id + '/');
        }
      }
    }

    function scrollToTop() {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    window.addEventListener('keydown', function(e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.key === 'ArrowLeft' || e.key === '[') {
        ${resolvedPrev ? `window.location.href = '../${resolvedPrev.id}/';` : ""}
      } else if (e.key === 'ArrowRight' || e.key === ']') {
        ${resolvedNext ? `window.location.href = '../${resolvedNext.id}/';` : ""}
      } else if (e.key === 'Escape') {
        closeAllModals();
      }
    });

    (function initDesktopHoverSensors() {
      var isDesktop = window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches;
      if (!isDesktop) return;

      var navEl = document.querySelector('.navbar');
      var floatEl = document.querySelector('.float-wrap');
      var topTimer = null;
      var floatTimer = null;

      window.addEventListener('mousemove', function(e) {
        var isMenuOpen = document.getElementById('settingsModal').classList.contains('open') ||
                         document.getElementById('drawer').classList.contains('open');

        if (e.clientY <= 65 || (navEl && navEl.contains(e.target))) {
          if (topTimer) { clearTimeout(topTimer); topTimer = null; }
          if (navEl) navEl.classList.add('hover-visible');
        } else if (!isMenuOpen) {
          if (!topTimer) {
            topTimer = setTimeout(function() {
              if (navEl) navEl.classList.remove('hover-visible');
              topTimer = null;
            }, 250);
          }
        }

        var distRight = window.innerWidth - e.clientX;
        var distBottom = window.innerHeight - e.clientY;
        if ((distRight <= 140 && distBottom <= 220) || (floatEl && floatEl.contains(e.target))) {
          if (floatTimer) { clearTimeout(floatTimer); floatTimer = null; }
          if (floatEl) floatEl.classList.add('hover-visible');
        } else if (!isMenuOpen) {
          if (!floatTimer) {
            floatTimer = setTimeout(function() {
              if (floatEl) floatEl.classList.remove('hover-visible');
              floatTimer = null;
            }, 250);
          }
        }
      }, { passive: true });
    })();
  </script>
</body>
</html>`;
}
