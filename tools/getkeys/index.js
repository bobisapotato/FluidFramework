msRestAzure = require('ms-rest-azure');
keyVault = require('azure-keyvault');
const { exec } = require('child_process');

(async () => {
    credentials = await msRestAzure.interactiveLogin();
    const keyVaultClient = new keyVault.KeyVaultClient(credentials);
    const vaultUri = "https://" + "prague-key-vault" + ".vault.azure.net/";

    console.log("Getting secrets...");
    const secretList = await keyVaultClient.getSecrets(vaultUri);
    for (const secret of secretList) {
        const secretName = secret.id.split('/').pop();
        keyVaultClient.getSecret(vaultUri, secretName, '').then((response) => {
            const envName = secretName.split('-').join('__'); // secret name can't contain underscores
            console.log(`Setting environment variable ${envName}...`);
            setEnv(envName, response.value);
        });
    }
})();

function setEnv(name, value) {
    const shell = process.env.SHELL ? process.env.SHELL.split('/').pop() : null;
    const setString = `export ${name}="${value}"`;
    switch (shell) {
        case "bash":
            return exec(`${setString} && echo '${setString}' >> ~/.bashrc`, stdResponse);
        case "zsh":
            return exec(`${setString} && echo '${setString}' >> ~/.zshrc`, stdResponse);
        case "fish":
            return exec(`set -xU '${name}' '${value}'`, {"shell": process.env.SHELL}, stdResponse);
        default: //windows
            return exec(`setx ${name} '${value}'`, stdResponse);
    }
}

function stdResponse(err, stdout, stderr) {
    console.log(err ? err : (stderr || stdout) ? stderr + stdout : "done");
}
