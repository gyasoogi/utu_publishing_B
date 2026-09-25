(() => {
  const DESIGN_WIDTH = 1920;
  const DESIGN_HEIGHT = 1080;
  const TARGET_IDS = ["web1", "web2", "web3", "web4", "file"];
  const FILL_EXCLUDE_IDS = ["web1", "web2", "web3", "web4", "bar"];
  // 이 값 이하에서는 요소 크기를 더 줄이지 않고 간격/위치만 조정한다.
  const MIN_GROUP_SCALE = 0.6;

  const canvas = document.getElementById("figma-canvas");
  if (!canvas) return;

  /*
   * 1) Move all target groups to the canvas root first.
   *    web1 is nested inside web2 in the export, but it is meant to be
   *    an independent responsive parent, so detach it before layout math.
   */
  const targets = TARGET_IDS
    .map(id => document.getElementById(id))
    .filter(Boolean);

  const targetSet = new Set(TARGET_IDS.concat(FILL_EXCLUDE_IDS));
  const directChildren = Array.from(canvas.children);

  // Background wrapper: everything except responsive foreground groups/bar.
  // Keep it as one full-size design layer so every vector and grid line scales
  // together and fills the viewport as a single background composition.
  const bgLayer = document.createElement("div");
  bgLayer.className = "responsive-bg-layer";
  bgLayer.setAttribute("aria-hidden", "true");
  bgLayer.style.position = "absolute";
  bgLayer.style.left = "50%";
  bgLayer.style.top = "50%";
  bgLayer.style.width = "1920px";
  bgLayer.style.height = "1080px";
  bgLayer.style.transformOrigin = "center center";
  bgLayer.style.pointerEvents = "none";

  const firstTarget = directChildren.find(el => targetSet.has(el.id));
  canvas.insertBefore(bgLayer, firstTarget || canvas.firstElementChild);

  for (const child of directChildren) {
    if (child === bgLayer) continue;
    if (!targetSet.has(child.id)) {
      bgLayer.appendChild(child);
    }
  }

  // Detach target groups from one another while preserving their original DOM order.
  const documentOrder = new Map();
  let orderIndex = 0;
  const walker = document.createTreeWalker(canvas, NodeFilter.SHOW_ELEMENT);
  let node;
  while ((node = walker.nextNode())) {
    if (targets.includes(node)) documentOrder.set(node, orderIndex);
    orderIndex += 1;
  }
  targets.sort((a, b) => documentOrder.get(a) - documentOrder.get(b));

  for (const group of targets) {
    canvas.appendChild(group);
  }

  /*
   * 2) Turn each target into a true parent coordinate system.
   *    We calculate its original 1920x1080 bounding box once.
   *    Every child's left/top is converted to coordinates relative to
   *    that parent exactly once. Width/height/font/SVG sizes are untouched.
   */
  const groupLayout = new Map();

  function parsePx(styleText, property) {
    const re = new RegExp('(?:^|;)\\s*' + property + '\\s*:\\s*(-?(?:\\d+(?:\\.\\d*)?|\\.\\d+))px', 'i');
    const match = styleText.match(re);
    return match ? parseFloat(match[1]) : null;
  }

  function getOriginalRect(el) {
    const style = el.getAttribute("style") || "";
    const left = parsePx(style, "left");
    const top = parsePx(style, "top");

    // Use the rendered size as a fallback because Figma SVG wrapper divs
    // often carry only left/top while their child <svg> contains the size.
    const rendered = el.getBoundingClientRect();
    const widthFromStyle = parsePx(style, "width");
    const heightFromStyle = parsePx(style, "height");

    return {
      left,
      top,
      width: widthFromStyle != null ? widthFromStyle : rendered.width,
      height: heightFromStyle != null ? heightFromStyle : rendered.height
    };
  }

  // Keep canvas at design size while reading original exported geometry.
  // Temporarily use the 1920x1080 design frame only while reading
  // the exported Figma geometry.
  const previousCanvasWidth = canvas.style.width;
  const previousCanvasHeight = canvas.style.height;
  canvas.style.width = `${DESIGN_WIDTH}px`;
  canvas.style.height = `${DESIGN_HEIGHT}px`;

  for (const group of targets) {
    // Establish a stable design-space parent before measuring its children.
    group.style.position = "absolute";
    group.style.left = "0px";
    group.style.top = "0px";
    group.style.width = `${DESIGN_WIDTH}px`;
    group.style.height = `${DESIGN_HEIGHT}px`;
    group.style.overflow = "visible";

    const elements = [group, ...group.querySelectorAll("*")];
    const boxes = [];

    for (const el of elements) {
      if (el === group) continue;
      const rect = getOriginalRect(el);

      // Most Figma-exported positioned layers carry left/top explicitly.
      if (rect.left == null || rect.top == null) continue;
      if (rect.width == null || rect.height == null) continue;

      boxes.push({ el, ...rect });
    }

    if (!boxes.length) {
      group.style.left = "0px";
      group.style.top = "0px";
      group.style.width = `${DESIGN_WIDTH}px`;
      group.style.height = `${DESIGN_HEIGHT}px`;
      groupLayout.set(group, { baseLeft: 0, baseTop: 0, baseWidth: DESIGN_WIDTH, baseHeight: DESIGN_HEIGHT });
      continue;
    }

    const minLeft = Math.min(...boxes.map(b => b.left));
    const minTop = Math.min(...boxes.map(b => b.top));
    const maxRight = Math.max(...boxes.map(b => b.left + b.width));
    const maxBottom = Math.max(...boxes.map(b => b.top + b.height));
    

    const baseWidth = Math.max(0.5, maxRight - minLeft);
    const baseHeight = Math.max(0.5, maxBottom - minTop);

    group.style.position = "absolute";
    group.style.left = `${minLeft}px`;
    group.style.top = `${minTop}px`;
    group.style.width = `${baseWidth}px`;
    group.style.height = `${baseHeight}px`;
    group.style.overflow = "visible";

    // Normalize every direct/descendant positioned layer into parent coordinates.
    // Only coordinates change here; dimensions remain untouched.
    for (const box of boxes) {
      const style = box.el.getAttribute("style") || "";
      if (box.left != null) {
        box.el.style.left = `${box.left - minLeft}px`;
      }
      if (box.top != null) {
        box.el.style.top = `${box.top - minTop}px`;
      }
    }

    groupLayout.set(group, {
      baseLeft: minLeft,
      baseTop: minTop,
      baseWidth,
      baseHeight
    });
  }
  

  // Return to the real browser viewport after geometry normalization.
  // 1920x1080 remains only the internal design/reference coordinate system.
  canvas.style.width = "100vw";
  canvas.style.height = "100vh";
  canvas.style.minWidth = "0";
  canvas.style.minHeight = "0";

  /*
   * 3) Responsive behavior:
   *    - parent groups move as a whole; no child coordinate is recomputed.
   *    - the actual canvas is always 100vw x 100vh.
   *    - 1920x1080 is used only as the internal design/reference coordinate system.
   *    - target parents keep their existing responsive behavior.
   *    - the bottom bar scales as a single unit to the viewport width.
   */
  function updateResponsiveLayout() {
    const vw = Math.max(document.documentElement.clientWidth, 1);
    const vh = Math.max(document.documentElement.clientHeight, 1);

    // 위치 이동은 기존 로직을 그대로 사용한다.
    const xRatio = vw / DESIGN_WIDTH;
    const yRatio = vh / DESIGN_HEIGHT;

    /*
     * web1~4/file의 크기는 일정 이하로 더 줄이지 않는다.
     * 1920x1080의 가로/세로 비율을 유지하면서 하나의 동일한 scale을 사용한다.
     *
     * scale이 MIN_GROUP_SCALE에 도달한 뒤에도
     * left/top은 계속 xRatio/yRatio에 따라 움직이므로
     * 화면이 더 작아질수록 그룹 사이의 간격이 자연스럽게 좁아진다.
     */
    const groupScale = Math.max(
      Math.min(xRatio, yRatio),
      MIN_GROUP_SCALE
    );

    const bar = document.getElementById("bar");
    if (bar) {
      bar.style.transform = `scale(${xRatio})`;
    }

    for (const [group, layout] of groupLayout) {
      // 기존 동적 위치 이동은 변경하지 않는다.
      group.style.left = `${layout.baseLeft * xRatio}px`;
      group.style.top = `${layout.baseTop * yRatio}px`;

      // 크기만 공통 균일 scale로 조정한다.
      group.style.transformOrigin = "top left";
      group.style.transform = `scale(${groupScale})`;
    }

    // 배경은 화면을 꽉 채우는 cover 방식으로 계산한다.
    // 전체 배경을 한 번에 스케일링해서 각 벡터가 함께 화면을 가득 채우도록 한다.
    const bgScale = Math.max(
      vw / DESIGN_WIDTH,
      vh / DESIGN_HEIGHT
    );

    const bgAdjustmentScale = 1;
    bgLayer.style.transform = `translate(calc(-50% + 70px), -50%) scale(${bgScale * bgAdjustmentScale})`;
    bgLayer.style.left = "50%";
    bgLayer.style.top = "50%";
    bgLayer.style.transformOrigin = "center center";
  }

  let resizeRaf = 0;
  function onResize() {
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(updateResponsiveLayout);
  }

  window.addEventListener("resize", onResize, { passive: true });
  window.addEventListener("orientationchange", onResize, { passive: true });
  updateResponsiveLayout();

  const pauseButton = document.getElementById("pause");
  const playButton = document.getElementById("play");
  const voiceAudio = new Audio("./voice.wav");

  function setAudioControlState(isPlaying) {
    if (!pauseButton || !playButton) return;

    pauseButton.style.display = isPlaying ? "none" : "block";
    playButton.style.display = isPlaying ? "block" : "none";
  }

  setAudioControlState(false);

  pauseButton?.addEventListener("click", () => {
    if (voiceAudio.paused) {
      voiceAudio.play();
      setAudioControlState(true);
    } else {
      voiceAudio.pause();
      setAudioControlState(false);
    }
  });

  playButton?.addEventListener("click", () => {
    if (!voiceAudio.paused) {
      voiceAudio.pause();
      setAudioControlState(false);
    } else {
      voiceAudio.play();
      setAudioControlState(true);
    }
  });

  voiceAudio.addEventListener("ended", () => {
    setAudioControlState(false);
  });

  voiceAudio.addEventListener("pause", () => {
    if (voiceAudio.ended) {
      setAudioControlState(false);
    }
  });
})();