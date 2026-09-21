<script lang="ts">
	import '@fontsource/zen-maru-gothic/500.css';
	import '@fontsource/zen-maru-gothic/700.css';
	import '@fontsource/zen-maru-gothic/900.css';
	import '../app.css';
	import Toast from '$lib/components/Toast.svelte';

	let { children } = $props();
</script>

{@render children()}
<Toast />
