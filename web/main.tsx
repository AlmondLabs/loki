import { createRoot } from "react-dom/client";

function App() {
  return (
    <div
      style={{
        height: "100%",
        display: "grid",
        placeItems: "center",
        color: "var(--loci-muted)",
        fontSize: 14,
        letterSpacing: "0.08em",
      }}
    >
      loci · desk coming up (U1)
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
