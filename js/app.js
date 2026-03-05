const data = await res.json();

const select = document.getElementById("issueSelect");
if (!select) return;

data
  .sort((a, b) => b.issue - a.issue)
  .forEach((i) => {
    const opt = document.createElement("option");
    opt.value = i.issue;
    opt.textContent = `${i.issue}호 (${i.date})`;
    select.appendChild(opt);
  });