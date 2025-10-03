import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import pool from "./db.js"; // conexión a PostgreSQL

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

// --------------------
// 1. Guardar datos del ESP32
// --------------------
app.post("/api/sensores", async (req, res) => {
  try {
    const { planta_id, temperatura, humedad_suelo, nivel_agua, agua_consumida } = req.body;

    if (!planta_id || temperatura === undefined || humedad_suelo === undefined) {
      return res.status(400).json({ error: "Faltan datos" });
    }

    // ✅ Guardar lectura
    const queryLectura = `
      INSERT INTO lecturas (planta_id, temperatura, humedad)
      VALUES ($1, $2, $3) RETURNING *;
    `;
    const resultLectura = await pool.query(queryLectura, [planta_id, temperatura, humedad_suelo]);

    // ✅ Guardar nivel de agua si viene
    if (nivel_agua !== undefined) {
      const altura_cm = (nivel_agua / 100.0) * 15.0; // ejemplo si tu tanque tiene 15cm
      const volumen_litros = (Math.PI * Math.pow(3, 2) * altura_cm) / 1000; // r=3cm, cm³->litros
      await pool.query(
        "INSERT INTO nivel_agua (altura, volumen) VALUES ($1, $2)",
        [altura_cm, volumen_litros]
      );
    }

    // ✅ Guardar evento de riego si hay agua consumida
    if (agua_consumida && agua_consumida > 0) {
      const litros = agua_consumida / 1000.0; // de ml a litros
      await pool.query(
        "INSERT INTO riegos (planta_id, cantidad_agua) VALUES ($1, $2)",
        [planta_id, litros]
      );
    }

    res.json(resultLectura.rows[0]);
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
    const result = await pool.query("SELECT * FROM lecturas ORDER BY fecha DESC LIMIT 20");
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
    const result = await pool.query("SELECT * FROM lecturas ORDER BY fecha DESC LIMIT 1");
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
// 5. Listar plantas de un usuario por correo
// --------------------
app.get("/api/plantas/:correo", async (req, res) => {
  try {
    const { correo } = req.params;
    const result = await pool.query(
      "SELECT * FROM plantas WHERE correo_usuario = $1 ORDER BY fecha_registro DESC",
      [correo]
    );
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error obteniendo plantas del usuario" });
  }
});

// --------------------
// 6. Agregar nueva planta
// --------------------
app.post("/api/plantas", async (req, res) => {
  try {
    const { nombre, ubicacion, id_tipo, correo_usuario } = req.body;
    if (!nombre || !id_tipo || !correo_usuario) {
      return res.status(400).json({ error: "Datos incompletos" });
    }

    const result = await pool.query(
      "INSERT INTO plantas (nombre, fecha_registro, ubicacion, id_tipo, correo_usuario) VALUES ($1, NOW(), $2, $3, $4) RETURNING *",
      [nombre, ubicacion || "", id_tipo, correo_usuario]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al registrar planta" });
  }
});

// --------------------
// Iniciar servidor
// --------------------
app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en http://localhost:${PORT}`);
});
