import { contextBridge, ipcRenderer } from 'electron';
import type { UploadProgress } from '../shared/publish';
import type {
	Api,
	ExportProgress,
	PresentCamera,
	PresentState,
	SubtitleProgress,
	TranscribeProgress
} from '../shared/types';

/** 画面には window.api だけを見せる。Node の機能は渡さない */
const api: Api = {
	settings: {
		get: () => ipcRenderer.invoke('settings:get'),
		save: (patch) => ipcRenderer.invoke('settings:save', patch),
		chooseLibraryFolder: () => ipcRenderer.invoke('settings:chooseLibraryFolder'),
		openLibraryFolder: () => ipcRenderer.invoke('settings:openLibraryFolder')
	},
	bgm: {
		list: () => ipcRenderer.invoke('bgm:list'),
		add: () => ipcRenderer.invoke('bgm:add'),
		importDownloads: () => ipcRenderer.invoke('bgm:importDownloads'),
		remove: (fileName) => ipcRenderer.invoke('bgm:remove', fileName),
		url: (fileName) => ipcRenderer.invoke('bgm:url', fileName)
	},
	present: {
		open: (noteId) => ipcRenderer.invoke('present:open', noteId),
		close: () => ipcRenderer.invoke('present:close'),
		isOpen: () => ipcRenderer.invoke('present:isOpen'),
		setOrientation: (portrait) => ipcRenderer.invoke('present:orientation', portrait),
		update: (state) => ipcRenderer.send('present:update', state),
		onUpdate: (cb) => {
			const handler = (_e: unknown, state: PresentState) => cb(state);
			ipcRenderer.on('present:state', handler);
			return () => ipcRenderer.removeListener('present:state', handler);
		},
		updateCamera: (camera) => ipcRenderer.send('present:camera', camera),
		onCamera: (cb) => {
			const handler = (_e: unknown, camera: PresentCamera) => cb(camera);
			ipcRenderer.on('present:camera', handler);
			return () => ipcRenderer.removeListener('present:camera', handler);
		},
		onOpenChange: (cb) => {
			const handler = (_e: unknown, open: boolean) => cb(open);
			ipcRenderer.on('present:open-changed', handler);
			return () => ipcRenderer.removeListener('present:open-changed', handler);
		}
	},
	folders: {
		list: () => ipcRenderer.invoke('folders:list'),
		save: (names) => ipcRenderer.invoke('folders:save', names)
	},
	transcripts: {
		get: (recordingId) => ipcRenderer.invoke('transcripts:get', recordingId),
		save: (transcript) => ipcRenderer.invoke('transcripts:save', transcript),
		generate: (recordingId) => ipcRenderer.invoke('transcripts:generate', recordingId),
		saveSubtitles: (recordingId) => ipcRenderer.invoke('transcripts:saveSubtitles', recordingId),
		proofread: (recordingId, cues) =>
			ipcRenderer.invoke('transcripts:proofread', recordingId, cues),
		onSubtitleProgress: (cb) => {
			const handler = (_e: unknown, p: SubtitleProgress) => cb(p);
			ipcRenderer.on('subtitles:progress', handler);
			return () => ipcRenderer.removeListener('subtitles:progress', handler);
		},
		onProgress: (cb) => {
			const handler = (_e: unknown, p: TranscribeProgress) => cb(p);
			ipcRenderer.on('transcripts:progress', handler);
			return () => ipcRenderer.removeListener('transcripts:progress', handler);
		}
	},
	images: {
		add: () => ipcRenderer.invoke('images:add'),
		// ファイルの中身を送る（ブラウザーから落とした画像など、パスの無いものも受け取れる）
		importFile: async (file) =>
			ipcRenderer.invoke('images:importData', file.name, new Uint8Array(await file.arrayBuffer())),
		remove: (fileName) => ipcRenderer.invoke('images:remove', fileName)
	},
	storage: {
		info: () => ipcRenderer.invoke('storage:info'),
		backup: () => ipcRenderer.invoke('storage:backup')
	},
	notes: {
		list: () => ipcRenderer.invoke('notes:list'),
		save: (note) => ipcRenderer.invoke('notes:save', note),
		remove: (id) => ipcRenderer.invoke('notes:remove', id)
	},
	recordings: {
		list: () => ipcRenderer.invoke('recordings:list'),
		save: (recording) => ipcRenderer.invoke('recordings:save', recording),
		remove: (id) => ipcRenderer.invoke('recordings:remove', id),
		fileUrl: (id) => ipcRenderer.invoke('recordings:fileUrl', id),
		revealInFinder: (id) => ipcRenderer.invoke('recordings:revealInFinder', id),
		begin: (meta) => ipcRenderer.invoke('recordings:begin', meta),
		append: (id, chunk) => ipcRenderer.invoke('recordings:append', id, chunk),
		finish: (id, meta) => ipcRenderer.invoke('recordings:finish', id, meta),
		exportFile: (id) => ipcRenderer.invoke('recordings:exportFile', id),
		exportMp4: (id, opts) => ipcRenderer.invoke('recordings:exportMp4', id, opts),
		cancelExport: (id) => ipcRenderer.invoke('recordings:cancelExport', id),
		exportInfo: (id, exportId) => ipcRenderer.invoke('recordings:exportInfo', id, exportId),
		copyExport: (id, exportId) => ipcRenderer.invoke('recordings:copyExport', id, exportId),
		removeExport: (id, exportId) => ipcRenderer.invoke('recordings:removeExport', id, exportId),
		onExportProgress: (cb) => {
			const handler = (_e: unknown, p: ExportProgress) => cb(p);
			ipcRenderer.on('recordings:export-progress', handler);
			return () => ipcRenderer.removeListener('recordings:export-progress', handler);
		}
	},
	legacy: {
		importBackup: () => ipcRenderer.invoke('legacy:importBackup')
	},
	publish: {
		youtubeStatus: () => ipcRenderer.invoke('publish:youtubeStatus'),
		youtubeConnect: () => ipcRenderer.invoke('publish:youtubeConnect'),
		youtubeDisconnect: () => ipcRenderer.invoke('publish:youtubeDisconnect'),
		youtubeUpload: (jobId, req) => ipcRenderer.invoke('publish:youtubeUpload', jobId, req),
		onProgress: (cb) => {
			const handler = (_e: unknown, p: UploadProgress) => cb(p);
			ipcRenderer.on('publish:progress', handler);
			return () => ipcRenderer.removeListener('publish:progress', handler);
		},
		pickImage: () => ipcRenderer.invoke('publish:pickImage'),
		imageDataUrl: (p) => ipcRenderer.invoke('publish:imageDataUrl', p),
		captureThumbnail: (id, rect, exportId) =>
			ipcRenderer.invoke('publish:captureThumbnail', id, rect, exportId),
		hubStatus: () => ipcRenderer.invoke('publish:hubStatus'),
		hubConnect: (platform) => ipcRenderer.invoke('publish:hubConnect', platform),
		hubDisconnect: (platform) => ipcRenderer.invoke('publish:hubDisconnect', platform),
		hubPost: (jobId, filePath, req) => ipcRenderer.invoke('publish:hubPost', jobId, filePath, req),
		hubJob: (id) => ipcRenderer.invoke('publish:hubJob', id),
		hubStep: (id) => ipcRenderer.invoke('publish:hubStep', id),
		compose: (recordingId, platforms) =>
			ipcRenderer.invoke('publish:compose', recordingId, platforms),
		hubJobs: () => ipcRenderer.invoke('publish:hubJobs'),
		hubTikTokCreator: () => ipcRenderer.invoke('publish:hubTikTokCreator'),
		hubCancel: (id) => ipcRenderer.invoke('publish:hubCancel', id),
		cancel: (jobId) => ipcRenderer.invoke('publish:cancel', jobId),
		hubReschedule: (id, when) => ipcRenderer.invoke('publish:hubReschedule', id, when),
		youtubeReschedule: (videoId, when) =>
			ipcRenderer.invoke('publish:youtubeReschedule', videoId, when),
		youtubeDelete: (videoId) => ipcRenderer.invoke('publish:youtubeDelete', videoId)
	},
	app: {
		version: () => ipcRenderer.invoke('app:version'),
		setFullScreen: (flag) => ipcRenderer.invoke('app:setFullScreen', flag),
		setBackgroundColor: (color) => ipcRenderer.invoke('app:setBackgroundColor', color),
		setWindowMode: (mode) => ipcRenderer.invoke('app:setWindowMode', mode),
		saveThumbnail: (rect, baseName) => ipcRenderer.invoke('app:saveThumbnail', rect, baseName),
		revealPath: (filePath) => ipcRenderer.invoke('app:revealPath', filePath),
		resizeBy: (dx) => ipcRenderer.invoke('app:resizeBy', dx),
		onFullScreenChange: (cb) => {
			const handler = (_e: unknown, isFullScreen: boolean) => cb(isFullScreen);
			ipcRenderer.on('app:fullscreen-changed', handler);
			return () => ipcRenderer.removeListener('app:fullscreen-changed', handler);
		}
	}
};

contextBridge.exposeInMainWorld('api', api);
