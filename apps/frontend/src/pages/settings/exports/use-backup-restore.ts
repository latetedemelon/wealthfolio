import {
  backupDatabase,
  backupDatabaseToPath,
  backupDatabaseToPendingExport,
  deleteDatabaseBackup,
  getDatabaseBackupDownloadUrl,
  isWeb,
  listDatabaseBackups,
  logger,
  openDatabaseFileDialog,
  openFolderDialog,
  restoreDatabase,
  saveAppDataFileViaPicker,
} from "@/adapters";
import { getPlatform as getRuntimePlatform, usePlatform } from "@/hooks/use-platform";
import { QueryKeys } from "@/lib/query-keys";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@wealthfolio/ui/components/ui/use-toast";

const HEALTHZ_URL = "/api/v1/healthz";

/**
 * After a web restore the server swaps the DB file and (by default) restarts to
 * rebuild its connection pool. Wait for it to come back, then reload the app so
 * every query refetches against the restored data.
 */
async function waitForServerReadyAndReload(timeoutMs = 90_000): Promise<void> {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  // The restore response is sent before the process exits; give it a moment to
  // begin restarting so we don't reload against the outgoing process.
  await sleep(1500);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(HEALTHZ_URL, { cache: "no-store" });
      if (res.ok) {
        window.location.reload();
        return;
      }
    } catch {
      // Server still restarting — keep polling.
    }
    await sleep(1500);
  }
  // Reload anyway so the user isn't stranded on a stale page.
  window.location.reload();
}

export function useBackupRestore() {
  const { platform } = usePlatform();
  const queryClient = useQueryClient();
  const platformMode: "desktop" | "mobile" | "web" = isWeb
    ? "web"
    : platform?.is_mobile
      ? "mobile"
      : "desktop";

  const {
    data: webBackups = [],
    isLoading: isLoadingWebBackups,
    isFetching: isFetchingWebBackups,
    isError: hasWebBackupsError,
    error: webBackupsError,
  } = useQuery({
    queryKey: [QueryKeys.DATABASE_BACKUPS],
    queryFn: listDatabaseBackups,
    enabled: isWeb,
  });

  const { mutateAsync: backupWithDirectorySelection, isPending: isBackingUp } = useMutation<{
    location: "local" | "server";
    value: string;
  } | null>({
    mutationFn: async () => {
      if (isWeb) {
        const { filename } = await backupDatabase();
        return { location: "server" as const, value: filename };
      }

      const runtimePlatform = await getRuntimePlatform();
      if (runtimePlatform.is_desktop) {
        // Open folder dialog to let user choose backup location
        const selectedDir = await openFolderDialog();

        if (!selectedDir) {
          // User cancelled the dialog, return null to indicate cancellation
          return null;
        }

        // Create backup in selected directory
        const backupPath = await backupDatabaseToPath(selectedDir);
        return { location: "local" as const, value: backupPath };
      }

      if (runtimePlatform.os !== "ios") {
        throw new Error("Backup export is currently supported on desktop, web, and iOS only");
      }

      // iOS: create backup and let user choose file destination.
      const { relativePath, filename } = await backupDatabaseToPendingExport();
      const saved = await saveAppDataFileViaPicker(relativePath, filename);
      if (!saved) {
        return null;
      }
      return { location: "local" as const, value: filename };
    },
    onSuccess: (result) => {
      if (result === null) {
        // User cancelled the operation, don't show any message
        return;
      }

      const description =
        result.location === "server"
          ? `Backup created on the server as ${result.value}`
          : `Backup saved as ${result.value}`;

      toast({
        title: "Backup completed successfully",
        description,
        variant: "success",
      });

      if (result.location === "server") {
        queryClient.invalidateQueries({ queryKey: [QueryKeys.DATABASE_BACKUPS] });
      }
    },
    onError: (error) => {
      logger.error(`Error during backup: ${String(error)}`);
      toast({
        title: "Backup failed",
        description: error instanceof Error ? error.message : "An unknown error occurred",
        variant: "destructive",
      });
    },
  });

  const { mutateAsync: deleteWebBackup, isPending: isDeletingWebBackup } = useMutation({
    mutationFn: deleteDatabaseBackup,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [QueryKeys.DATABASE_BACKUPS] });
      toast({
        title: "Backup deleted",
        variant: "success",
      });
    },
    onError: (error) => {
      logger.error(`Error deleting backup: ${String(error)}`);
      toast({
        title: "Delete failed",
        description: error instanceof Error ? error.message : "An unknown error occurred",
        variant: "destructive",
      });
    },
  });

  const { mutateAsync: restoreWebBackup, isPending: isRestoringWebBackup } = useMutation({
    mutationFn: async (filename: string) => {
      toast({
        title: "Restoring backup",
        description: "The server will restart to finish the restore — this page will reload.",
      });
      await restoreDatabase(filename);
      await waitForServerReadyAndReload();
    },
    onError: (error) => {
      logger.error(`Error during web restore: ${String(error)}`);
      toast({
        title: "Restore failed",
        description: error instanceof Error ? error.message : "An unknown error occurred",
        variant: "destructive",
      });
    },
  });

  const { mutateAsync: restoreFromBackup, isPending: isRestoring } = useMutation({
    mutationFn: async () => {
      if (isWeb) {
        throw new Error("Restore is only supported in the desktop app");
      }

      const runtimePlatform = await getRuntimePlatform();
      if (!runtimePlatform.is_desktop && runtimePlatform.os !== "ios") {
        throw new Error("Restore is currently supported on desktop and iOS only");
      }

      // Open file dialog to let user choose backup file
      const selectedFile = await openDatabaseFileDialog();

      if (!selectedFile) {
        // User cancelled the dialog, return null to indicate cancellation
        return null;
      }

      // Restore database from selected file
      await restoreDatabase(selectedFile);
      return selectedFile;
    },
    onSuccess: (filePath) => {
      if (filePath === null) {
        // User cancelled the operation, don't show any message
        return;
      }
    },
    onError: (error) => {
      logger.error(`Error during restore: ${String(error)}`);
      toast({
        title: "Restore failed",
        description: error instanceof Error ? error.message : "An unknown error occurred",
        variant: "destructive",
      });
    },
  });

  const performBackup = async () => {
    try {
      await backupWithDirectorySelection();
    } catch (error) {
      logger.error(`Backup error: ${String(error)}`);
    }
  };

  const performRestore = async () => {
    const runtimePlatform = await getRuntimePlatform();
    if (!runtimePlatform.is_desktop && runtimePlatform.os !== "ios") {
      toast({
        title: "Restore unavailable",
        description: "Please use the desktop app or iOS app to restore backups.",
      });
      return;
    }

    try {
      await restoreFromBackup();
    } catch (error) {
      logger.error(`Restore error: ${String(error)}`);
    }
  };

  // Web restore: swap the live DB from an existing server-side backup, then the
  // server restarts and the page reloads (handled in the mutation).
  const performWebRestore = async (filename: string) => {
    try {
      await restoreWebBackup(filename);
    } catch (error) {
      logger.error(`Web restore error: ${String(error)}`);
    }
  };

  return {
    performBackup,
    performRestore,
    performWebRestore,
    deleteWebBackup,
    getWebBackupDownloadUrl: getDatabaseBackupDownloadUrl,
    isBackingUp,
    isRestoring: isRestoring || isRestoringWebBackup,
    isDeletingWebBackup,
    isLoadingWebBackups,
    isFetchingWebBackups,
    webBackupsError: hasWebBackupsError
      ? webBackupsError instanceof Error
        ? webBackupsError.message
        : "Unable to load database backups"
      : null,
    canBackup: platformMode !== "mobile" || platform?.os === "ios",
    canRestore: platformMode === "desktop" || platformMode === "web" || platform?.os === "ios",
    isIOS: platform?.os === "ios",
    isDesktop: platformMode === "desktop",
    isMobile: platformMode === "mobile",
    isWeb,
    webBackups,
    platformMode,
  };
}
