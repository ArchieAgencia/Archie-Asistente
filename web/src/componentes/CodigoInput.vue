<script setup lang="ts">
import { ref, watch } from 'vue';
const modelo = defineModel<string>({ default: '' });
const props = defineProps<{ etiqueta: string; autofoco?: boolean }>();
const celdas = ref<HTMLInputElement[]>([]);
const digitos = ref<string[]>(['', '', '', '', '', '']);
watch(modelo, (v) => { if (v === '') digitos.value = ['', '', '', '', '', '']; });

function actualizar() { modelo.value = digitos.value.join(''); }
function escribir(i: number, ev: Event) {
  const v = (ev.target as HTMLInputElement).value.replace(/\D/g, '');
  digitos.value[i] = v.slice(-1);
  (ev.target as HTMLInputElement).value = digitos.value[i]!;
  actualizar();
  if (v && i < 5) celdas.value[i + 1]?.focus();
}
function tecla(i: number, ev: KeyboardEvent) {
  if (ev.key === 'Backspace' && !digitos.value[i] && i > 0) celdas.value[i - 1]?.focus();
}
function pegar(ev: ClipboardEvent) {
  const t = (ev.clipboardData?.getData('text') ?? '').replace(/\D/g, '').slice(0, 6);
  if (!t) return;
  ev.preventDefault();
  digitos.value = t.padEnd(6, ' ').split('').map((c) => c.trim());
  actualizar();
  celdas.value[Math.min(t.length, 5)]?.focus();
}
defineExpose({ enfocar: () => celdas.value[0]?.focus() });
</script>

<template>
  <div>
    <span class="etq" :id="'cod-' + props.etiqueta.length">{{ etiqueta }}</span>
    <div class="digitos" role="group" :aria-labelledby="'cod-' + props.etiqueta.length" @paste="pegar">
      <input v-for="(_, i) in 6" :key="i" :ref="(el) => { if (el) celdas[i] = el as HTMLInputElement }" class="dig" inputmode="numeric"
        autocomplete="one-time-code" maxlength="1" :aria-label="`Dígito ${i + 1}`" :value="digitos[i]" :autofocus="autofoco && i === 0"
        @input="escribir(i, $event)" @keydown="tecla(i, $event)" />
    </div>
  </div>
</template>
