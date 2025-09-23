import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import pool from "./db.js"; // conexión a PostgreSQL

const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares
app.use(cors());
app.use(bodyParser.json());

// Ruta de prueba
app.get("/", (req, res) => {
  res.send("🌱 API Sensores funcionando...");
});


// --------------------
// 1. Guardar datos del ESP32
// --------------------
app.post("/api/sensores", async (req, res) => {
  try {
    const { planta_id, temperatura, humedad_suelo } = req.body;

    if (!planta_id || temperatura === undefined || humedad_suelo === undefined) {
      return res.status(400).json({ error: "Faltan datos" });
    }

    const query = `
      INSERT INTO lecturas (planta_id, temperatura, humedad_suelo, fecha)
      VALUES ($1, $2, $3, NOW())
      RETURNING *;
    `;
    const values = [planta_id, temperatura, humedad_suelo];
    const result = await pool.query(query, values);

    res.json(result.rows[0]); // devolvemos solo la fila insertada
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error en el servidor" });
  }
});


// --------------------
// 2. Consultar histórico (últimos 20 registros)
// --------------------
app.get("/api/sensores", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM lecturas ORDER BY fecha DESC LIMIT 20"
    );
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error en la consulta" });
  }
});


// --------------------
// 3. Último dato
// --------------------
app.get("/api/sensores/ultimo", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM lecturas ORDER BY fecha DESC LIMIT 1"
    );
    res.json(result.rows[0] || {});
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error en la consulta" });
  }
});


// --------------------
// 4. Histórico por planta
// --------------------
app.get("/api/sensores/planta/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      "SELECT * FROM lecturas WHERE planta_id = $1 ORDER BY fecha DESC LIMIT 50",
      [id]
    );
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error en la consulta por planta" });
  }
});


// --------------------
// Iniciar servidor
// --------------------
app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en http://localhost:${PORT}`);
});
