package it.ilmiopiano.app;

import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.ArrayList;

/**
 * "Condividi con Il mio Piano": riceve il file di un allenamento (FIT, TCX, GPX)
 * condiviso da un'altra app (Bryton Active, Wahoo…) e lo passa alla pagina web,
 * che lo legge con l'importazione degli allenamenti. Il file non viene salvato:
 * resta in memoria solo finché la pagina non lo prende.
 */
@CapacitorPlugin(name = "FileCondiviso")
public class FileCondivisoPlugin extends Plugin {

    private static final int MAX_BYTE = 25 * 1024 * 1024;
    private JSObject inAttesa = null;

    @Override
    public void load() {
        leggiIntent(getActivity().getIntent());
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        if (leggiIntent(intent)) notifyListeners("fileCondiviso", new JSObject(), true);
    }

    /** La pagina chiede il file arrivato (all'apertura o dopo l'avviso): una volta sola. */
    @PluginMethod
    public void prendi(PluginCall call) {
        JSObject risposta = inAttesa != null ? inAttesa : new JSObject();
        inAttesa = null;
        call.resolve(risposta);
    }

    private boolean leggiIntent(Intent intent) {
        if (intent == null) return false;
        String azione = intent.getAction();
        Uri uri = null;
        if (Intent.ACTION_SEND.equals(azione)) {
            uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(azione)) {
            // si importa un allenamento alla volta: il primo file condiviso
            ArrayList<Uri> uris = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (uris != null && !uris.isEmpty()) uri = uris.get(0);
        } else {
            return false;
        }
        if (uri == null) return false;
        try (InputStream in = getContext().getContentResolver().openInputStream(uri)) {
            if (in == null) return false;
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int letti, totale = 0;
            while ((letti = in.read(buf)) != -1) {
                totale += letti;
                if (totale > MAX_BYTE) return false;
                out.write(buf, 0, letti);
            }
            JSObject file = new JSObject();
            file.put("nome", nomeFile(uri));
            file.put("dati", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP));
            inAttesa = file;
            // l'intent è stato consumato: se l'app viene ricreata non lo rilegge
            intent.setAction(Intent.ACTION_MAIN);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private String nomeFile(Uri uri) {
        try (Cursor c = getContext().getContentResolver().query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                String n = c.getString(0);
                if (n != null && !n.isEmpty()) return n;
            }
        } catch (Exception e) {
            // nome non disponibile
        }
        String ultimo = uri.getLastPathSegment();
        return ultimo != null ? ultimo : "allenamento.fit";
    }
}
