import express from "express";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json()); // para leer JSON en el body

// Ruta de prueba
app.get("/", (req, res) => {
  res.send("Servidor ESP32 backend funcionando 🚀");
});

// Endpoint para recibir datos del ESP32
app.post("/api/sensores", (req, res) => {
  console.log("Datos recibidos:", req.body);
  res.json({ message: "Datos recibidos correctamente" });
});

app.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
});
