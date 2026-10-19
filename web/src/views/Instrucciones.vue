<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api, mensajeError } from '../api';
import { fechaHora } from '../format';
import { cargarResumen, sesion } from '../store';

interface Estado { texto: string; actualizadoEn: string | null; max: number }
const texto = ref(''); const guardado = ref(''); const max = ref(2000); const actualizadoEn = ref<string | null>(null);
const error = ref(''); const aviso = ref(''); const ocupado = ref(false); const cargando = ref(true);
const esAdmin = computed(() => sesion.yo?.rol === 'admin');
const cambio = computed(() => texto.value !== guardado.value);

const EJEMPLO = `Somos la Clínica Dental Sonríe, en Medellín. Atendemos de lunes a sábado de 8 a. m. a 6 p. m.
Tono: cercano y respetuoso, tuteamos a los pacientes. Nunca prometemos resultados médicos.
Servicios: limpieza, ortodoncia, blanqueamiento y urgencias.
Las campañas siempre salen con el asunto en minúsculas y sin signos de exclamación.`;

onMounted(async () => {
  try { const e = await api<Estado>('GET', '/api/panel/instrucciones'); texto.value = guardado.value = e.texto; max.value = e.max; actualizadoEn.value = e.actualizadoEn; }
  catch (x) { error.value = mensajeError(x); } finally { cargando.value = false; }
});

async function guardar() {
  error.value = ''; aviso.value = ''; ocupado.value = true;
  try {
    const e = await api<Estado>('POST', '/api/panel/instrucciones', { texto: texto.value });
    texto.value = guardado.value = e.texto; actualizadoEn.value = e.actualizadoEn;
    aviso.value = 'Guardado. Archie AI lo usará desde su próxima respuesta.';
    void cargarResumen();
  } catch (x) { error.value = mensajeError(x); } finally { ocupado.value = false; }
}
</script>

<template>
  <header class="encabezado"><h1 class="titulo"><em>Instrucciones</em> para Archie AI</h1></header>
  <p class="sec" style="margin-bottom:12px">Cuéntale a Archie AI cómo es tu negocio: tono, servicios, horarios, políticas. Lo usa en todas las conversaciones de tu cuenta para responder mejor y redactar borradores a tu estilo.</p>
  <p v-if="error" class="aviso error" role="alert">{{ error }}</p>
  <p v-if="aviso" class="aviso ok" role="status">{{ aviso }}</p>
  <p v-if="cargando" class="sec" role="status">Cargando…</p>
  <section v-else class="card" aria-labelledby="ins">
    <label id="ins" class="lbl v" for="texto">Sobre tu negocio</label>
    <textarea id="texto" v-model="texto" class="campo" rows="10" :maxlength="max" :disabled="!esAdmin || ocupado" :placeholder="esAdmin ? EJEMPLO : ''" style="padding:10px 14px;resize:vertical;margin-top:6px" />
    <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:8px">
      <button v-if="esAdmin" class="btn" type="button" :disabled="ocupado || !cambio" @click="guardar">Guardar</button>
      <span class="sec" style="font-size:15px">{{ texto.length }} de {{ max }} caracteres<span v-if="actualizadoEn"> · última actualización {{ fechaHora(actualizadoEn) }}</span></span>
    </div>
    <p v-if="!esAdmin" class="sec" style="margin-top:8px">Solo un administrador puede cambiar las instrucciones.</p>
    <ul class="sec" style="margin:14px 0 0;padding-left:20px;font-size:16px">
      <li>No escribas contraseñas, claves ni datos personales de tus contactos: lo que pongas aquí viaja al proveedor de IA en cada pregunta.</li>
      <li>Las instrucciones sirven para dar contexto y estilo. No le dan permisos nuevos ni cambian lo que Archie AI puede hacer: enviar, pausar o borrar siempre te pide confirmación.</li>
    </ul>
  </section>
</template>
