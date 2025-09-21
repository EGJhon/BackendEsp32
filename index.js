const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const pool = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares
app.use(cors());
app.use(bodyParser.json());

// Ruta de prueba
app.get('/', (req, res) => {
  res.send('🌱 API Sensores funcionando...');
});

// Guardar datos del ESP32
app.post('/api/sensores', async (req, res) => {
  try {
    const { planta_id, temperatura, humedad_suelo } = req.body;

    if (!planta_id || temperatura === undefined || humedad_suelo === undefined) {
      return res.status(400).json({ error: 'Faltan datos' });
    }

    const query = `
      INSERT INTO lecturas (planta_id, temperatura, humedad_suelo, fecha)
      VALUES ($1, $2, $3, NOW())
      RETURNING *;
    `;
    const values = [planta_id, temperatura, humedad_suelo];
    const result = await pool.query(query, values);

    res.json({ message: 'Datos guardados ✅', data: result.rows[0] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error en el servidor' });
  }
});

// Consultar histórico
app.get('/api/sensores', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM lecturas ORDER BY fecha DESC LIMIT 20');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Error en la consulta' });
  }
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en http://localhost:${PORT}`);
});
