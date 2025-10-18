import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import pool from "./db.js"; // conexión a PostgreSQL
import mqtt from "mqtt";     // --- NUEVO ---

const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares
app.use(cors());
app.use(bodyParser.json());

// --- NUEVO: CONFIGURACIÓN MQTT ---
const MQTT_BROKER = "762358bc25e4449fb40ac5b6645ff3dc.s1.eu.hivemq.cloud";
const MQTT_PORT = 8883;
const MQTT_USER = "JhonE";     // <--- RELLENA ESTO
const MQTT_PASSWORD = "192837465Jhon";  // <--- RELLENA ESTO
const MQTT_TOPIC = "sensores/planta/datos"; // Mismo topic que en el ESP32

// Opciones de conexión
const mqttOptions = {
  host: MQTT_BROKER,
  port: MQTT_PORT,
  protocol: 'mqtts', // 'mqtts' para conexiones seguras TLS (puerto 8883)
  username: MQTT_USER,
  password: MQTT_PASSWORD
};

// 1. Conectar al Broker MQTT
console.log("🚀 Intentando conectar al Broker MQTT...");
const client = mqtt.connect(mqttOptions);

// 2. Evento 'connect' (cuando se conecta)
client.on('connect', () => {
  console.log('✅ Conectado exitosamente al Broker MQTT');
  
  // Suscribirse al topic
  client.subscribe(MQTT_TOPIC, (err) => {
    if (!err) {
      console.log(`👂 Suscrito al topic: ${MQTT_TOPIC}`);
    } else {
      console.error('Error al suscribirse:', err);
    }
  });
});

// 3. Evento 'message' (cuando llega un mensaje)
//    Esta es la parte MÁS IMPORTANTE
client.on('message', async (topic, payload) => {
  // El payload llega como un Buffer, lo convertimos a String
  const messageString = payload.toString();
  console.log(`[MQTT] Mensaje recibido en ${topic}: ${messageString}`);

  try {
    // Convertimos el string (que es un JSON) a un objeto
    const datos = JSON.parse(messageString);

    const { planta_id, temperatura, humedad, nivel_agua, agua_consumida } = datos;

    // --- Esta es la MISMA lógica que tu ruta POST ---
    const query = `
      INSERT INTO lecturas (planta_id, temperatura, humedad, nivel_agua, agua_consumida, fecha)
      VALUES ($1, $2, $3, $4, $5, NOW())
      RETURNING *;
    `;
    const values = [planta_id, temperatura, humedad, nivel_agua || null, agua_consumida || null];
    
    // Ejecutamos la consulta
    const result = await pool.query(query, values);
    console.log('[MQTT] Datos guardados en la BD:', result.rows[0]);

  } catch (error) {
    console.error("[MQTT] Error al procesar el mensaje o guardar en BD:", error);
  }
});

// 4. Eventos de error o reconexión (opcional pero recomendado)
client.on('error', (err) => {
  console.error('Error de MQTT:', err);
});

client.on('reconnect', () => {
  console.log('Reconectando al Broker MQTT...');
});
// --- FIN DE LA SECCIÓN MQTT ---


// ===================================
// TUS RUTAS HTTP (NO CAMBIAN NADA)
// ===================================
// Tu API seguirá funcionando exactamente igual que antes.
// Puedes usar POST para pruebas y MQTT para el ESP32.

// Ruta de prueba
app.get("/", (req, res) => {
  res.send("🌱 API Sensores funcionando (ahora también con MQTT)...");
});

app.post("/api/sensores", async (req, res) => {
  try {
    const { planta_id, temperatura, humedad, nivel_agua, agua_consumida } = req.body;

    if (!planta_id || temperatura === undefined || humedad === undefined) {
      return res.status(400).json({ error: "Faltan datos" });
    }

    const query = `
      INSERT INTO lecturas (planta_id, temperatura, humedad, nivel_agua, agua_consumida, fecha)
      VALUES ($1, $2, $3, $4, $5, NOW())
      RETURNING *;
    `;
    const values = [planta_id, temperatura, humedad, nivel_agua || null, agua_consumida || null];
    const result = await pool.query(query, values);

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error en POST /api/sensores:", error);
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
// 5. Último nivel de agua (solo memoria)
// --------------------
app.get("/api/sensores/nivel-agua/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      "SELECT nivel_agua FROM lecturas WHERE planta_id = $1 ORDER BY fecha DESC LIMIT 1",
      [id]
    );

    if (result.rows.length === 0) {
      // No hay registros todavía
      return res.json({ nivel_agua: null, mensaje: "Aún no se ha recibido nivel de agua" });
    }

    res.json({ nivel_agua: result.rows[0].nivel_agua, mensaje: "Último nivel obtenido correctamente" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error en la consulta por nivel de agua" });
  }
});

//  Listar plantas de un usuario por correo
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

//  Agregar nueva planta
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
// Pega esto en tu archivo de servidor (ej. index.js)
// junto con tus otras rutas GET y POST.

app.get("/api/reporte/planta/:id", async (req, res) => {
  try {
    const { id } = req.params;

    // 1. Reporte de 24 horas (Temp y Hum)
    const query24h = `
      SELECT
        AVG(temperatura) AS temp_avg,
        MAX(temperatura) AS temp_max,
        MIN(temperatura) AS temp_min,
        AVG(humedad) AS hum_avg,
        MAX(humedad) AS hum_max,
        MIN(humedad) AS hum_min
      FROM lecturas
      WHERE planta_id = $1 AND fecha >= NOW() - INTERVAL '24 hours'
    `;
    const res24h = await pool.query(query24h, [id]);

    // 2. Reporte de 7 días (Consumo de agua)
    const query7d = `
      SELECT
        SUM(agua_consumida) AS agua_total
      FROM lecturas
      WHERE planta_id = $1 AND fecha >= NOW() - INTERVAL '7 days'
    `;
    const res7d = await pool.query(query7d, [id]);

    // Combinamos los resultados en un solo objeto
    const reporte = {
      ...res24h.rows[0],
      ...res7d.rows[0]
    };

    res.json(reporte);

  } catch (error) {
    console.error("Error en GET /api/reporte/planta/:id", error);
    res.status(500).json({ error: "Error en el servidor al generar reporte" });
  }
});
app.get("/api/planta/tipo/:id", async (req, res) => {
  try {
    const { id } = req.params; // Este es el ID de la planta (de la tabla 'plantas')

    // Consulta SQL que une 'plantas' con 'tipo_planta'
    const query = `
      SELECT T.temp_min, T.temp_max, T.hum_min, T.hum_max
      FROM tipo_planta T
      JOIN plantas P ON T.id = P.id_tipo
      WHERE P.id = $1;
    `;
    
    const result = await pool.query(query, [id]);

    if (result.rows.length === 0) {
      // Si no encuentra, devuelve valores 'nulos' para no romper el frontend
      return res.json({ temp_min: null, temp_max: null, hum_min: null, hum_max: null });
    }

    res.json(result.rows[0]); // Devuelve { temp_min: 15, temp_max: 30, ... }

  } catch (error) {
    console.error("Error en GET /api/planta/tipo/:id", error);
    res.status(500).json({ error: "Error en el servidor" });
  }
});

// --------------------
// Iniciar servidor
// --------------------
app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en http://localhost:${PORT}`);
});

