const menuButton = document.querySelector(".menu-toggle");
const navigation = document.querySelector("#main-nav");

function closeMenu() {
  menuButton.setAttribute("aria-expanded", "false");
  navigation.classList.remove("is-open");
}

menuButton.addEventListener("click", () => {
  const expanded = menuButton.getAttribute("aria-expanded") !== "true";
  menuButton.setAttribute("aria-expanded", String(expanded));
  navigation.classList.toggle("is-open", expanded);
});
navigation
  .querySelectorAll("a")
  .forEach((link) => link.addEventListener("click", closeMenu));
document.addEventListener("keydown", (event) => {
  if (
    event.key === "Escape" &&
    menuButton.getAttribute("aria-expanded") === "true"
  ) {
    closeMenu();
    menuButton.focus();
  }
});
document.addEventListener("click", (event) => {
  if (!navigation.contains(event.target) && !menuButton.contains(event.target))
    closeMenu();
});
window.matchMedia("(min-width: 901px)").addEventListener("change", closeMenu);

const tabs = [...document.querySelectorAll('[role="tab"]')];
function selectTab(selected) {
  tabs.forEach((tab) => {
    const active = tab === selected;
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
    document.getElementById(tab.getAttribute("aria-controls")).hidden = !active;
  });
}
tabs.forEach((tab, index) => {
  tab.addEventListener("click", () => selectTab(tab));
  tab.addEventListener("keydown", (event) => {
    let next;
    if (event.key === "ArrowRight") next = tabs[(index + 1) % tabs.length];
    if (event.key === "ArrowLeft")
      next = tabs[(index - 1 + tabs.length) % tabs.length];
    if (event.key === "Home") next = tabs[0];
    if (event.key === "End") next = tabs[tabs.length - 1];
    if (next) {
      event.preventDefault();
      selectTab(next);
      next.focus();
    }
  });
});

const filters = [...document.querySelectorAll("[data-filter]")];
const cards = [...document.querySelectorAll("[data-category]")];
filters.forEach((button) =>
  button.addEventListener("click", () => {
    const category = button.dataset.filter;
    filters.forEach((filter) =>
      filter.setAttribute("aria-pressed", String(filter === button)),
    );
    let visible = 0;
    cards.forEach((card) => {
      card.hidden = category !== "all" && card.dataset.category !== category;
      if (!card.hidden) visible++;
    });
    document.querySelector("#filter-status").textContent =
      `${button.childNodes[0].textContent.trim()} 기술 ${visible}개 표시`;
  }),
);

// Build metadata is written into the image by Dockerfile; this is not live health data.
fetch("version.json", { cache: "no-store" })
  .then((response) => (response.ok ? response.json() : null))
  .then((version) => {
    if (!version || !/^[a-f0-9]{40}$/.test(version.commit)) return;
    const link = document.createElement("a");
    link.href = `https://github.com/Undery33/Buteami/commit/${version.commit}`;
    link.textContent = `배포 버전 · ${version.commit.slice(0, 7)} ↗`;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.setAttribute(
      "aria-label",
      `배포 커밋 ${version.commit.slice(0, 7)} 확인 (새 탭)`,
    );
    document.querySelector("#release-info").replaceChildren(link);
  })
  .catch(() => {
    /* Keep the static release label if metadata is unavailable. */
  });
