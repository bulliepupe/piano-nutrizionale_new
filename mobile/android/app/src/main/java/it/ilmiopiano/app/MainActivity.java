package it.ilmiopiano.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // plugin locale per "Condividi con Il mio Piano" (file degli allenamenti)
        registerPlugin(FileCondivisoPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
