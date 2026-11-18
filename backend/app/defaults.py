"""Séquence et réglages par défaut, utilisés tant que rien n'a été enregistré."""

DEFAULT_SETTINGS = {
    "me": "Votre prénom",
    "offer": (
        "je développe des applications IA pour les professionnels du droit, qui font gagner des heures "
        "sur la recherche, la relecture et la rédaction, sans jamais compromettre le secret professionnel"
    ),
}

DEFAULT_STEPS = [
    {
        "id": "s1", "day": 0, "channel": "linkedin", "title": "Invitation LinkedIn", "subject": "",
        "body": "Bonjour {prenom}, {accroche} J'accompagne des cabinets et des juristes sur l'IA appliquée au droit, "
                "et je serais ravi d'échanger avec vous ici. {moi}",
    },
    {
        "id": "s2", "day": 2, "channel": "linkedin", "title": "Message après acceptation", "subject": "",
        "body": "Merci d'avoir accepté, {prenom} !\n\nUne question rapide : chez {entreprise}, combien de temps passez-vous "
                "chaque semaine à relire des contrats, rechercher dans vos dossiers ou rédiger des actes récurrents ?\n\n"
                "C'est exactement le temps que mes applications IA permettent de récupérer, avec des données qui restent confidentielles.",
    },
    {
        "id": "s3", "day": 4, "channel": "email", "title": "Email principal",
        "subject": "Gagner du temps sur vos dossiers, {prenom}",
        "body": "Bonjour {prenom},\n\n{accroche}\n\nJe vous écris car {offre}.\n\nConcrètement, voici ce que je mets en place :\n"
                "- un assistant qui retrouve en quelques secondes la bonne information dans vos dossiers, contrats et jurisprudences\n"
                "- l'analyse automatique d'un contrat : clauses sensibles, écarts avec vos modèles, points à négocier\n"
                "- la rédaction de premiers jets (courriers, conclusions, actes récurrents) à partir de vos propres modèles\n\n"
                "Vos documents restent sous votre contrôle : hébergement maîtrisé, aucune donnée réutilisée pour entraîner une IA.\n\n"
                "Seriez-vous ouvert à un échange de 15 minutes pour voir ce que cela donnerait pour {entreprise} ?\n\n"
                "Bien cordialement,\n{moi}\n\nPS : si ce n'est pas le bon moment, dites-le-moi simplement et je ne vous relancerai pas.",
    },
    {
        "id": "s4", "day": 9, "channel": "email", "title": "Relance avec démo",
        "subject": "Re: Gagner du temps sur vos dossiers, {prenom}",
        "body": "Bonjour {prenom},\n\nJe me permets de remonter mon message. Pour que ce soit concret, je peux vous montrer "
                "en 15 minutes une démo sur un contrat type ou un dossier anonymisé de votre choix, sans engagement.\n\n"
                "Cela vous intéresserait ?\n\nBien cordialement,\n{moi}",
    },
    {
        "id": "s5", "day": 16, "channel": "email", "title": "Dernier message",
        "subject": "Re: Gagner du temps sur vos dossiers, {prenom}",
        "body": "Bonjour {prenom},\n\nSans retour de votre part, j'imagine que ce n'est pas une priorité en ce moment. "
                "Je ne vous relancerai plus.\n\nLe jour où la recherche documentaire ou la relecture vous prend trop de temps, "
                "je reste disponible pour en parler.\n\nBien cordialement,\n{moi}",
    },
]
