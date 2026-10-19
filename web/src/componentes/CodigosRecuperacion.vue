<script setup lang="ts">
import { ref } from 'vue';

const props = defineProps<{ codigos: string[] }>();
const emit = defineEmits<{ (e: 'guardados'): void }>();
const copiado = ref(false);
const texto = () => `Archie AI - códigos de recuperación\nCada código sirve una sola vez. Guárdalos en un lugar seguro (por ejemplo, tu gestor de contraseñas).\n\n${props.codigos.join('\n')}\n`;

async function copiar() {
  try { await navigator.clipboard.writeText(props.codigos.join('\n')); copiado.value = true; } catch { copiado.value = false; }
}
function descargar() {
  const url = URL.createObjectURL(new Blob([texto()], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = 'archie-ai-codigos-de-recuperacion.txt'; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
</script>

<template>
  <div class="card" style="border:1.5px solid var(--accion);margin-top:14px" role="region" aria-label="Códigos de recuperación">
    <h3 class="sub" style="font-size:22px">Tus códigos de <em>recuperación</em></h3>
    <p class="aviso alerta" role="alert" style="margin-top:10px"><b>Guárdalos ahora.</b> Solo los mostramos esta vez. Si pierdes tu teléfono, cada código te deja entrar una sola vez.</p>
    <ul class="mono" style="list-style:none;padding:0;margin:14px 0;display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:8px;font-size:18px">
      <li v-for="c in codigos" :key="c" style="user-select:all">{{ c }}</li>
    </ul>
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      <button class="btn2" type="button" @click="copiar">{{ copiado ? 'Copiados' : 'Copiar' }}</button>
      <button class="btn2" type="button" @click="descargar">Descargar (.txt)</button>
      <button class="btn" type="button" @click="emit('guardados')">Ya los guardé</button>
    </div>
  </div>
</template>
