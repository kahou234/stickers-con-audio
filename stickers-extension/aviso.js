const q = new URLSearchParams(location.search);
document.getElementById(q.get("por") === "link" ? "link" : "apagado").hidden = false;
document.getElementById("otraVez").addEventListener("click", async () => {
  try {
    const r = await fetch("http://localhost:4195/api/hola");
    if (!r.ok) throw new Error();
    location.href = `http://localhost:4195/?url=${encodeURIComponent(q.get("link") || "")}`;
  } catch {
    document.getElementById("otraVez").textContent = "Sigue apagado. Probar otra vez";
  }
});
