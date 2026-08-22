import React from "react";
import { createRoot } from "react-dom/client";
import Schreibknecht from "./Schreibknecht.jsx";
import "./grund.css";

createRoot(document.getElementById("wurzel")).render(
  <React.StrictMode><Schreibknecht /></React.StrictMode>
);
